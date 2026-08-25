import { sql } from "./db.ts";
import { classifyByRules, type RuleInput } from "./classifyRules.ts";
import { classifyWithClaude, encodeVisualFewShots, type ClaudeInput, type FewShot, type VisualFewShot } from "./classifyClaude.ts";
import { REVIEW_THRESHOLD, type Template } from "./taxonomy.ts";

interface ClassifiableRow extends RuleInput {
  id: string;
}

// Anthropic per-MTok pricing for claude-sonnet-4-6 (input / output).
const CLAUDE_IN_PER_MTOK = 3;
const CLAUDE_OUT_PER_MTOK = 15;

// Posts still needing a Stage-1 label: unclassified, not human-verified, and a
// main post (replies aren't tracked, so never spend a rule/Claude pass on them).
async function fetchUnsettled(): Promise<ClassifiableRow[]> {
  return sql<ClassifiableRow>`
    SELECT id, text, domains, mentions, media_type, is_reply, is_self_reply, is_quote,
           COALESCE(ARRAY(SELECT lower(u->>'expanded_url') FROM jsonb_array_elements(posts.urls) u
                          WHERE u->>'expanded_url' IS NOT NULL), '{}')
             || CASE WHEN link_resolved_url IS NOT NULL THEN ARRAY[lower(link_resolved_url)] ELSE '{}'::text[] END
             AS urls
    FROM posts
    WHERE template IS NULL AND class_source IS DISTINCT FROM 'human' AND is_reply = false`;
}

export interface RuleRunResult {
  scanned: number;
  settled: number;
  unsettled: number;
  byTemplate: Record<string, number>;
}

// Stage-1 pass. Settles the posts rules can decide with high confidence and
// leaves the rest (template stays NULL) for Stage-2 (Claude). When `reRunRules`
// is set, previously rule-labeled posts are first reset to NULL so that rows a
// refined rule no longer settles correctly revert to unclassified (human and
// Claude labels are never touched).
export async function runRuleClassification(reRunRules = false): Promise<RuleRunResult> {
  if (reRunRules) {
    await sql`
      UPDATE posts SET template = NULL, confidence = NULL, reasoning = NULL,
        class_source = NULL, classified_at = NULL
      WHERE class_source = 'rule'`;
  }
  const rows = await fetchUnsettled();
  const byTemplate: Record<string, number> = {};
  let settled = 0;

  for (const r of rows) {
    const res = classifyByRules(r);
    if (res.template) {
      await sql`
        UPDATE posts SET
          template = ${res.template}::content_template,
          confidence = ${res.confidence},
          reasoning = ${res.reasoning},
          class_source = 'rule',
          classified_at = now(),
          updated_at = now()
        WHERE id = ${r.id} AND class_source IS DISTINCT FROM 'human'
      `;
      settled++;
      byTemplate[res.template] = (byTemplate[res.template] ?? 0) + 1;
    }
  }

  return { scanned: rows.length, settled, unsettled: rows.length - settled, byTemplate };
}

// ---------------------------------------------------------------------------
// Stage-2: Claude multimodal classification for posts the rules left unsettled.
// ---------------------------------------------------------------------------

// Up to `limit` human-verified labels as few-shot examples, newest first. My
// corrections are the ground truth; they steer future calls toward my taxonomy.
async function getFewShots(limit = 10): Promise<FewShot[]> {
  const rows = await sql<{ text: string; template: Template }>`
    SELECT p.text, l.template
    FROM labels l JOIN posts p ON p.id = l.post_id
    ORDER BY l.labeled_at DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({ text: r.text, template: r.template }));
}

// Templates whose identity is carried by the IMAGE, not the text — the ones
// Claude confuses without a visual anchor (Jay's quote-card crossover problem).
const VISUAL_TEMPLATES: Template[] = [
  "quote_card",
  "data_motion_visual",
  "integration_announcement",
  "product_post",
  "short_form_video_eco",
  "dev_doc_post",
];

// One canonical exemplar IMAGE per visual template, drawn from our own corpus:
// prefer a human-verified post, else the highest-confidence one, that actually
// has an image. Fetched+encoded once per run (see encodeVisualFewShots) and
// reused for every classification, so the cost is a handful of images total.
async function getVisualFewShots(): Promise<VisualFewShot[]> {
  const rows = await sql<{
    template: Template;
    media_type: string;
    preview_image_url: string | null;
    media_urls: string[];
    link_image_url: string | null;
    quoted_image_url: string | null;
  }>`
    SELECT DISTINCT ON (template)
      template, media_type, preview_image_url, media_urls, link_image_url, quoted_image_url
    FROM posts
    WHERE template = ANY(${VISUAL_TEMPLATES}::content_template[])
      AND is_reply = false
      AND (preview_image_url IS NOT NULL
           OR jsonb_array_length(media_urls) > 0
           OR link_image_url IS NOT NULL
           OR quoted_image_url IS NOT NULL)
    ORDER BY template,
      (class_source = 'human') DESC NULLS LAST,
      confidence DESC NULLS LAST,
      created_at DESC`;
  return encodeVisualFewShots(rows);
}

interface ClaudeRow extends ClaudeInput {
  id: string;
}

export interface ClaudeRunResult {
  scanned: number;
  classified: number;
  review: number; // how many landed below the review threshold or as 'other'
  byTemplate: Record<string, number>;
  costUsd: number;
  errors: string[];
}

// Classify up to `limit` unsettled posts. Sequential to stay well under API
// rate limits; each result is written immediately so a mid-run failure still
// makes progress. Human labels are never touched.
export async function runClaudeClassification(limit = 600): Promise<ClaudeRunResult> {
  const rows = await sql<ClaudeRow>`
    SELECT id, text, domains, mentions, media_type, is_reply, is_self_reply, is_quote,
           COALESCE(ARRAY(SELECT lower(u->>'expanded_url') FROM jsonb_array_elements(posts.urls) u
                          WHERE u->>'expanded_url' IS NOT NULL), '{}')
             || CASE WHEN link_resolved_url IS NOT NULL THEN ARRAY[lower(link_resolved_url)] ELSE '{}'::text[] END
             AS urls,
           preview_image_url, media_urls, link_title, link_description, link_image_url
    FROM posts
    WHERE template IS NULL AND class_source IS DISTINCT FROM 'human' AND is_reply = false
    ORDER BY created_at DESC
    LIMIT ${limit}`;

  // Fetch text few-shots and the VISUAL exemplars once, then reuse across every
  // post in this run (Jay's "drag 5 quote cards in" — but generalized to one
  // canonical image per visually-distinct template, pulled from our own
  // human-labeled/high-confidence posts).
  const [fewShots, visualFewShots] = await Promise.all([getFewShots(), getVisualFewShots()]);
  const byTemplate: Record<string, number> = {};
  const errors: string[] = [];
  let classified = 0;
  let review = 0;
  let costUsd = 0;

  for (const r of rows) {
    try {
      const res = await classifyWithClaude(r, fewShots, visualFewShots);
      if (res.usage) {
        costUsd += (res.usage.input * CLAUDE_IN_PER_MTOK + res.usage.output * CLAUDE_OUT_PER_MTOK) / 1_000_000;
      }
      await sql`
        UPDATE posts SET
          template = ${res.template}::content_template,
          confidence = ${res.confidence},
          reasoning = ${res.reasoning},
          class_source = 'claude',
          classified_at = now(),
          updated_at = now()
        WHERE id = ${r.id} AND class_source IS DISTINCT FROM 'human'`;
      classified++;
      byTemplate[res.template] = (byTemplate[res.template] ?? 0) + 1;
      if (res.confidence < REVIEW_THRESHOLD || res.template === "other") review++;
    } catch (err) {
      errors.push(err instanceof Error ? err.message.slice(0, 200) : String(err));
      // No key, bad key, or an empty balance fails identically for every
      // remaining post — stop instead of burning the whole queue on it.
      if (/credit balance|401|invalid.*api.*key|ANTHROPIC_API_KEY/i.test(String(err))) break;
    }
  }

  return { scanned: rows.length, classified, review, byTemplate, costUsd: Number(costUsd.toFixed(4)), errors };
}

// Apply a human correction from the review queue: record ground truth in
// `labels` (feeds the few-shot pool) and set the post's label as human-verified.
export async function applyHumanLabel(postId: string, template: Template, by: string): Promise<boolean> {
  const prev = await sql<{ template: Template | null; class_source: string | null }>`
    SELECT template, class_source FROM posts WHERE id = ${postId}`;
  if (!prev.length) return false;
  await sql`
    INSERT INTO labels (post_id, template, labeled_by, prev_template, prev_source)
    VALUES (${postId}, ${template}::content_template, ${by},
            ${prev[0].template}::content_template, ${prev[0].class_source}::classification_source)`;
  await sql`
    UPDATE posts SET
      template = ${template}::content_template,
      confidence = 1.0,
      class_source = 'human',
      classified_at = now(),
      updated_at = now()
    WHERE id = ${postId}`;
  return true;
}

// Convenience: the current classification breakdown across all posts.
export async function classificationBreakdown(): Promise<{ template: Template | null; source: string | null; n: number }[]> {
  const rows = await sql<{ template: Template | null; source: string | null; n: number }>`
    SELECT template, class_source AS source, COUNT(*)::int AS n
    FROM posts GROUP BY template, class_source ORDER BY n DESC`;
  return rows;
}

// ---------------------------------------------------------------------------
// Re-classification. Used when the TAXONOMY itself changes, not when new posts
// arrive — the descriptions in lib/taxonomy.ts are what Stage 2 classifies
// against, so redefining a pillar means everything already filed under it was
// filed under the old definition.
//
// Concretely: "Integration Announcement" became "New Chain Integrations in Eco"
// (a new blockchain going live in Eco), and partner/company integrations of Eco
// products moved into "Product Posts". Roughly a third of the old bucket was
// partner integrations, so those rows had to be re-decided.
//
// Auto-applies, per Robert: anything that lands wrong is one click to re-file in
// the review queue. Human labels are still never touched.
// ---------------------------------------------------------------------------

export interface Flip {
  id: string;
  url: string;
  from: Template | null;
  to: Template | null;
  confidence: number | null;
  text: string;
}

export interface ReclassifyResult {
  reset: number;
  ruleSettled: number;
  claudeClassified: number;
  costUsd: number;
  flips: Flip[];
  stayed: number;
  errors: string[];
}

export async function reclassify(templates: Template[]): Promise<ReclassifyResult> {
  const before = await sql<{ id: string; template: Template }>`
    SELECT id, template FROM posts
    WHERE template = ANY(${templates}::content_template[])
      AND class_source IS DISTINCT FROM 'human'
      AND is_reply = false`;
  const prev = new Map(before.map((r) => [r.id, r.template]));

  await sql`
    UPDATE posts SET template = NULL, confidence = NULL, reasoning = NULL,
      class_source = NULL, classified_at = NULL, updated_at = now()
    WHERE id = ANY(${before.map((r) => r.id)})`;

  const rules = await runRuleClassification(false);
  const claude = await runClaudeClassification();

  const after = await sql<{ id: string; url: string; template: Template | null; confidence: number | null; text: string }>`
    SELECT id, url, template, confidence, text FROM posts WHERE id = ANY(${before.map((r) => r.id)})`;

  const flips: Flip[] = [];
  let stayed = 0;
  for (const a of after) {
    const from = prev.get(a.id) ?? null;
    if (a.template === from) stayed++;
    else flips.push({ id: a.id, url: a.url, from, to: a.template, confidence: a.confidence, text: a.text });
  }

  return {
    reset: before.length,
    ruleSettled: rules.settled,
    claudeClassified: claude.classified,
    costUsd: claude.costUsd,
    flips,
    stayed,
    errors: claude.errors,
  };
}
