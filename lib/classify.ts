import { sql } from "./db";
import { classifyByRules, type RuleInput } from "./classifyRules";
import { classifyWithClaude, type ClaudeInput, type FewShot } from "./classifyClaude";
import { REVIEW_THRESHOLD, type Template } from "./taxonomy";

interface ClassifiableRow extends RuleInput {
  id: string;
}

// Anthropic per-MTok pricing for claude-sonnet-4-6 (input / output).
const CLAUDE_IN_PER_MTOK = 3;
const CLAUDE_OUT_PER_MTOK = 15;

// Posts still needing a Stage-1 label: unclassified and not human-verified.
async function fetchUnsettled(): Promise<ClassifiableRow[]> {
  return sql<ClassifiableRow>`
    SELECT id, text, domains, mentions, media_type, is_reply, is_self_reply, is_quote
    FROM posts
    WHERE template IS NULL AND class_source IS DISTINCT FROM 'human'`;
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
           preview_image_url, media_urls
    FROM posts
    WHERE template IS NULL AND class_source IS DISTINCT FROM 'human'
    ORDER BY created_at DESC
    LIMIT ${limit}`;

  const fewShots = await getFewShots();
  const byTemplate: Record<string, number> = {};
  const errors: string[] = [];
  let classified = 0;
  let review = 0;
  let costUsd = 0;

  for (const r of rows) {
    try {
      const res = await classifyWithClaude(r, fewShots);
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
      if (/401|invalid.*api.*key|ANTHROPIC_API_KEY/i.test(String(err))) break; // no key → stop
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
