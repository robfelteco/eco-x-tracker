import Anthropic from "@anthropic-ai/sdk";
import { extractDimensions } from "./dimensions.ts";
import {
  getLaneRegistry,
  laneDirectory,
  upsertLane,
  type LaneKind,
  type LaneRegistry,
} from "./laneRegistry.ts";

// The sync-time lane detector.
//
// It answers one question about one post: "does this post belong to a lane we
// do not have?" That question only has to be asked because the two halves of
// the pipeline generalise differently. Stage-2 classification is a model, so it
// filed the Arc announcement under New Chain Integrations having never heard of
// Arc. Dimension tagging is a regex over a fixed vocabulary, so it wrote
// chains = {} on the same row. The post then counted toward the pillar's clock
// and fed no lane — indistinguishable from success on every screen in the app.
//
// Three properties this has to have, in order of how expensive getting them
// wrong is:
//
//   1. It must not invent lanes. Sixteen of the twenty-one untagged posts in
//      the table are bare `https://t.co/…` amplifier posts whose whole body is
//      a link. A detector that fires on "untagged" alone would propose sixteen
//      lanes out of nothing and cost a Claude call each. So: a prose floor
//      before the model is called at all, the full existing lane directory in
//      the prompt, and an explicit "none" that the model is told is the common
//      answer.
//   2. It must not ask twice. Every post the detector looks at is recorded in
//      lane_detect_seen with its outcome, so a sync over history is paid for
//      once and steady-state cost is one call per genuinely new subject.
//   3. It must not resurrect. A lane the operator dismissed stays dismissed
//      even if the same post is re-read — the answer "no, that is not a lane"
//      is a fact about the lane, not about that sync.

const MODEL = process.env.LANE_DETECT_MODEL || "claude-sonnet-4-6";

// Below this many characters of actual prose (t.co links stripped) there is
// nothing to reason about. A link-only amplifier post carries its subject in
// the article behind it, and that article is already the thing the lane would
// be drawn from.
const MIN_PROSE_CHARS = 60;

// Hard ceiling per sync, so a first run over history cannot produce a surprise
// bill. Whatever is left is picked up by the next sync.
const MAX_CALLS_PER_RUN = Number(process.env.LANE_DETECT_MAX_CALLS || 25);

const ID_RE = /^[a-z][a-z0-9_]{1,39}$/;

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
    _client = new Anthropic();
  }
  return _client;
}

type SqlTag = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...params: unknown[]
) => Promise<T[]>;

interface CandidateRow {
  id: string;
  text: string;
  template: string;
  mentions: string[];
  domains: string[];
  link_title: string | null;
  link_description: string | null;
  chains: string[];
  products: string[];
  entities: string[];
}

export interface DetectedLane {
  status: "new" | "existing";
  kind: LaneKind;
  id: string;
  label: string;
  handles: string[];
  terms: string[];
  brief: string | null;
  why: string;
  postId: string;
}

export interface LaneDetectResult {
  scanned: number;
  called: number;
  created: DetectedLane[];
  widened: DetectedLane[];
  retagged: number;
  errors: string[];
}

function prose(text: string): string {
  return (text || "").replace(/https?:\/\/t\.co\/\w+/g, "").trim();
}

/**
 * Posts worth asking about: in a pillar that rotates on a lane, carrying real
 * prose, missing the tag that pillar's lanes are built from, and not already
 * answered.
 *
 * Both pillars qualify on the SAME rule — the tag that pillar's lanes are built
 * from is missing — and the partner axis is deliberately not allowed to excuse
 * a missing product tag. The first version of this query skipped a product post
 * that already named a registered partner, on the reasoning that it was "a
 * partner post, not a product post". Eco Smart Deposits for Circle Gateway is
 * exactly that post, and it is the launch of a product: it was skipped, and the
 * missing Smart Deposits lane was one of the three the operator reported. A
 * post can be about a new product AND a known partner at once, and the axes
 * have to be judged separately.
 */
async function candidates(sql: SqlTag, _reg: LaneRegistry): Promise<CandidateRow[]> {
  return sql<CandidateRow>`
    SELECT p.id, p.text, p.template, p.mentions, p.domains,
           p.link_title, p.link_description, p.chains, p.products, p.entities
    FROM posts p
    LEFT JOIN lane_detect_seen s ON s.post_id = p.id
    WHERE p.is_reply = false
      AND s.post_id IS NULL
      AND (
        (p.template = 'integration_announcement' AND COALESCE(array_length(p.chains, 1), 0) = 0)
        OR (p.template = 'product_post' AND COALESCE(array_length(p.products, 1), 0) = 0)
      )
    ORDER BY p.created_at DESC
  `;
}

// --- Term hygiene ----------------------------------------------------------
//
// The detector's first run proposed `arc` as a hard match term for the Arc
// chain and `penny` for B2C2. Both are ordinary English words, and a hard term
// matches on any post regardless of context — this is precisely the failure
// lib/dimensions.ts already carries a paragraph about, where a Western Union
// post was tagged Stellar for the word "stellar" and a phantom chain chip
// appeared on it. A model will keep proposing them because in the post it is
// reading, the word genuinely is the subject.
//
// Three guards, cheapest first:
//
//   1. Length. Under four characters is never distinctive enough. Arc keeps its
//      @arc handle, which is the reliable signal anyway.
//   2. Corpus frequency, checked against the table rather than a hand-written
//      stoplist. A genuinely new subject cannot already be all over the
//      archive: if a proposed term matches more than a handful of posts that
//      predate the lane, the word is doing something other than naming it.
//   3. Everything that survives lands in loose_terms, not terms — matched only
//      when the post also mentions Eco, the same gate `routes` has carried in
//      lib/products.ts since the product registry was written. Only @handles,
//      which cannot be ordinary words, are taken as hard signal.
const MIN_TERM_CHARS = 4;

// How many existing posts a proposed term may match before it is treated as an
// ordinary word rather than a name. Deliberately low: a new lane's subject
// should appear in the handful of posts that motivated it, not more.
const MAX_TERM_MATCHES = 6;

async function keepTerms(sql: SqlTag, terms: string[]): Promise<{ kept: string[]; dropped: string[] }> {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const t of terms) {
    if (t.length < MIN_TERM_CHARS) {
      dropped.push(`${t} (too short)`);
      continue;
    }
    // Word-boundary match in Postgres, mirroring hasToken() in lib/dimensions.ts.
    const rows = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM posts
      WHERE is_reply = false AND text ~* ('\\m' || ${t} || '\\M')
    `;
    const n = rows[0]?.n ?? 0;
    if (n > MAX_TERM_MATCHES) dropped.push(`${t} (matches ${n} posts — reads as an ordinary word)`);
    else kept.push(t);
  }
  return { kept, dropped };
}

function promptFor(row: CandidateRow, reg: LaneRegistry): string {
  const pillar =
    row.template === "integration_announcement"
      ? "New Chain Integrations — a blockchain going live in Eco. The subject is a CHAIN."
      : "Product Posts — an Eco product, or a company shipping Eco infra in their own product.";

  return `You maintain the lane registry for Eco's content tracker. A "lane" is a recurring subject the team rotates through: a chain Eco routes on, an Eco product, or a partner company running Eco in production. Each lane gets its own clock, so a lane that does not exist is a subject that can go cold with nobody noticing.

This post was filed under: ${pillar}
It carries no tag on that pillar's lane axis, which usually means either (a) it is about something not yet in the registry, or (b) it is generic and belongs to no lane at all. (b) is common — say so plainly when it is the answer.

LANES THAT ALREADY EXIST:
${laneDirectory(reg)}

POST:
${prose(row.text) || "(no text)"}

@mentions: ${row.mentions?.length ? row.mentions.map((m) => "@" + m).join(" ") : "none"}
link card: ${row.link_title ?? "none"}${row.link_description ? ` — ${row.link_description.slice(0, 300)}` : ""}

Reply with JSON only:
{"lanes": [{"status": "new" | "existing", "kind": "chain" | "product" | "partner", "id": "snake_case_id", "label": "Display Name", "handles": ["xhandle"], "terms": ["distinctive text token"], "brief": "2-3 sentences: what it is, who it is for, the mechanism", "why": "one line"}], "note": "one line"}

Rules:
- Empty "lanes" array is the right answer for a generic post with no specific subject. Do not stretch.
- "existing" means the subject IS in the list above but the tagger missed it. Give the existing id and only the handles/terms that would have caught it — do not restate its brief.
- "new" needs a proper noun that is genuinely the subject. A company merely mentioned is not a partner lane; a partner lane means they run Eco infra in their own product.
- kind "chain" only for an actual blockchain or L1/L2 network.
- handles: X handles WITHOUT the @, lowercased, exactly as they appear above.
- terms: only tokens that are unambiguous in ordinary English. Skip a term you would not want matched in an unrelated post.
- id: lowercase, snake_case, no spaces.
- At most 3 lanes.`;
}

interface ModelLane {
  status?: string;
  kind?: string;
  id?: string;
  label?: string;
  handles?: string[];
  terms?: string[];
  brief?: string | null;
  why?: string;
}

function parseReply(raw: string): { lanes: ModelLane[]; note: string } {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) return { lanes: [], note: "unparseable reply" };
  const obj = JSON.parse(cleaned.slice(start, end + 1));
  return { lanes: Array.isArray(obj.lanes) ? obj.lanes : [], note: String(obj.note ?? "") };
}

/**
 * Re-tag every post against the current vocabulary and write back the rows that
 * changed.
 *
 * Creating a lane is only half the job: the posts that motivated it are already
 * in the table with empty arrays, and a lane with no posts behind it shows up
 * as "never posted" — the opposite of the truth. This is the same recomputation
 * scripts/backfill-dimensions.ts does, run inline because the corpus is small
 * (hundreds of rows) and because a lane the operator can see but whose posts
 * have not landed in it is worse than no lane.
 */
export async function retagAll(sql: SqlTag, reg: LaneRegistry): Promise<number> {
  const rows = await sql<{
    id: string;
    text: string;
    mentions: string[];
    domains: string[];
    media_type: string;
    link_title: string | null;
    chains: string[];
    entities: string[];
    products: string[];
  }>`SELECT id, text, mentions, domains, media_type, link_title, chains, entities, products FROM posts`;

  let changed = 0;
  const same = (a: string[] | null, b: string[]) => {
    const x = a ?? [];
    return x.length === b.length && x.every((v, i) => v === b[i]);
  };

  for (const r of rows) {
    const dim = extractDimensions(
      {
        text: r.text,
        mentions: r.mentions || [],
        domains: r.domains || [],
        mediaType: r.media_type,
        linkTitle: r.link_title,
      },
      reg.vocab,
    );
    if (same(r.chains, dim.chains) && same(r.entities, dim.entities) && same(r.products, dim.products)) continue;
    await sql`
      UPDATE posts SET chains = ${dim.chains}, entities = ${dim.entities}, products = ${dim.products}, updated_at = now()
      WHERE id = ${r.id}
    `;
    changed++;
  }
  return changed;
}

/**
 * Look at every untagged post in a lane-bearing pillar, register what it finds,
 * and re-tag the corpus so the new lanes have their posts in them.
 *
 * Safe to call on every sync: the seen table makes the steady-state cost one
 * call per new subject, and zero when nothing new shipped.
 */
export async function detectLanes(sql: SqlTag): Promise<LaneDetectResult> {
  const result: LaneDetectResult = { scanned: 0, called: 0, created: [], widened: [], retagged: 0, errors: [] };
  if (!process.env.ANTHROPIC_API_KEY) {
    result.errors.push("ANTHROPIC_API_KEY is not set — lane detection skipped");
    return result;
  }

  let reg = await getLaneRegistry(sql);
  const rows = await candidates(sql, reg);
  result.scanned = rows.length;

  for (const row of rows) {
    if (result.called >= MAX_CALLS_PER_RUN) break;

    // Below the prose floor there is nothing to read. Record it so the same
    // link-only post is never reconsidered.
    if (prose(row.text).length < MIN_PROSE_CHARS && !row.link_title) {
      await sql`
        INSERT INTO lane_detect_seen (post_id, outcome, note) VALUES (${row.id}, 'none', 'link-only post, below prose floor')
        ON CONFLICT (post_id) DO UPDATE SET checked_at = now(), outcome = EXCLUDED.outcome, note = EXCLUDED.note
      `;
      continue;
    }

    let lanes: ModelLane[] = [];
    let note = "";
    try {
      result.called++;
      const res = await client().messages.create({
        model: MODEL,
        max_tokens: 1200,
        messages: [{ role: "user", content: promptFor(row, reg) }],
      });
      const raw = res.content.map((c) => ("text" in c ? c.text : "")).join("");
      ({ lanes, note } = parseReply(raw));
    } catch (err) {
      result.errors.push(`${row.id}: ${(err as Error).message}`);
      continue;
    }

    let wrote = false;
    for (const l of lanes.slice(0, 3)) {
      const kind = l.kind as LaneKind;
      const id = (l.id ?? "").trim().toLowerCase();
      if (!["chain", "product", "partner"].includes(kind)) continue;
      if (!ID_RE.test(id)) continue;
      // An operator's "no" is permanent. Re-reading the post that produced the
      // lane must not undo it.
      if (reg.dismissed.has(`${kind}|${id}`)) continue;

      const handles = (l.handles ?? []).map((h) => h.replace(/^@/, "").toLowerCase()).filter(Boolean);
      const terms = (l.terms ?? []).map((t) => t.toLowerCase().trim()).filter((t) => t.length > 2);
      const existing = reg.byKind[kind].some((r) => r.id === id);

      if (existing || l.status === "existing") {
        // Widening a reviewed lane is the higher-risk write: a bad term here
        // mis-tags posts that are currently correct. Handles are proof of
        // subject; free text is not, so only handles are taken.
        if (!handles.length) continue;
        await upsertLane(sql, {
          kind,
          id,
          label: reg.labels[kind][id] ?? l.label ?? id,
          handles,
          evidencePostId: row.id,
          evidenceNote: l.why ?? note,
          reviewed: true, // it was already a lane; nothing new to review
        });
        result.widened.push({ status: "existing", kind, id, label: reg.labels[kind][id] ?? id, handles, terms: [], brief: null, why: l.why ?? note, postId: row.id });
        wrote = true;
        continue;
      }

      const { kept, dropped } = await keepTerms(sql, terms);
      if (dropped.length) result.errors.push(`${id}: dropped term ${dropped.join("; ")}`);

      // A brand-new lane with nothing to match on would be inert — it would sit
      // in the registry and never tag a post. Require at least one signal.
      if (!handles.length && !kept.length) continue;

      await upsertLane(sql, {
        kind,
        id,
        label: (l.label ?? id).trim(),
        handles,
        // Model-proposed text goes in loose_terms — see the Term hygiene note.
        looseTerms: kept,
        brief: l.brief ?? null,
        evidencePostId: row.id,
        evidenceNote: l.why ?? note,
        source: "auto",
        reviewed: false,
      });
      result.created.push({
        status: "new",
        kind,
        id,
        label: (l.label ?? id).trim(),
        handles,
        terms: kept,
        brief: l.brief ?? null,
        why: l.why ?? note,
        postId: row.id,
      });
      wrote = true;
    }

    await sql`
      INSERT INTO lane_detect_seen (post_id, outcome, note)
      VALUES (${row.id}, ${wrote ? "proposed" : "none"}, ${note.slice(0, 500) || null})
      ON CONFLICT (post_id) DO UPDATE SET checked_at = now(), outcome = EXCLUDED.outcome, note = EXCLUDED.note
    `;

    // Re-read after a write so the directory handed to the next post already
    // contains what this one created — two posts about the same new chain
    // should produce one lane, not two spellings of it.
    if (wrote) reg = await getLaneRegistry(sql);
  }

  if (result.created.length || result.widened.length) {
    result.retagged = await retagAll(sql, reg);
  }
  return result;
}
