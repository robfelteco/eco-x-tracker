import { sql } from "./db.ts";
import { ANALOG_BY_ID, ANALOG_DEFS, type AnalogDef } from "./analogs.ts";

// Source material for the curriculum — find it, VERIFY it, store it, hand it to
// the drafter.
//
// The rule this module exists to enforce: a curriculum post never gets drafted
// from nothing. We are teaching mechanisms to readers who work in those
// mechanisms daily, so an unsourced assertion about how CHIPS settles is the
// fastest way to lose the audience we are trying to earn.
//
// Verification is not optional and not cosmetic. A model asked for citations
// will happily produce plausible URLs that 404, and a confident citation to a
// page that does not exist is worse than no citation — it converts a small gap
// into a credibility problem. So every discovered URL is fetched before it is
// stored, and only rows with verified = true are ever shown to the drafter.

const XAI_MODEL = "grok-4.3";

export type SourceKind = "article" | "report" | "video" | "primer" | "standard" | "regulation";

export type SourceTier = "canonical" | "current";

export interface AnalogSource {
  id: number;
  analogId: string;
  title: string;
  publisher: string | null;
  url: string;
  kind: string | null;
  publishedOn: string | null;
  summary: string | null;
  keyFacts: string[];
  verified: boolean;
  sourceOf: string;
  /** canonical = the mechanism, never expires. current = timely, 365-day window. */
  tier: SourceTier;
  /** 'body' when we scraped the piece, 'description' for a video we never heard. */
  factsSource: string | null;
  /**
   * raw_documents row holding this source's FULL text. NULL means we have never
   * ingested the piece — only its metadata — and it is therefore NOT draftable.
   * See migration 013: drafting from metadata is what produced posts arguing a
   * mechanism the cited source never mentions.
   */
  textDocId: number | null;
  /** Days since first seen. Drives the "newest 6d" read on the shelf. */
  ageDays: number | null;
}

// Retention for a 'current' source, per Rob. Deliberately long: nothing is
// thrown away for a year. Freshness is expressed at the READ instead, by
// ordering on recency and capping what the drafter sees.
export const CURRENT_RETENTION_DAYS = 365;

// How many of each tier reach the drafter on the LEGACY blended path, where one
// prompt carries several sources and the model picks one. A post needs one
// mechanism source to be correct and one recent source to be timely; handing
// over twenty of each makes the prompt expensive and the draft vaguer.
//
// Per-source drafting does not use these. See draftableSources() below: when
// each source gets its own call there is no prompt to crowd, so there is no
// reason to hide sources from the operator.
const DRAFT_CANONICAL = 2;
const DRAFT_CURRENT = 2;

// Ceiling on a single fan-out click. The shelf's widest concept has 8 verified
// sources today; this exists so a future sweep that returns forty cannot turn
// one click into forty model calls.
export const MAX_FANOUT_SOURCES = 10;

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getSourcesFor(analogId: string): Promise<AnalogSource[]> {
  return sql<AnalogSource>`
    SELECT id, analog_id AS "analogId", title, publisher, url, kind,
           published_on AS "publishedOn", summary, key_facts AS "keyFacts",
           verified, source_of AS "sourceOf", tier, facts_source AS "factsSource",
           text_doc_id AS "textDocId",
           EXTRACT(DAY FROM now() - added_at)::int AS "ageDays"
    FROM analog_sources
    WHERE analog_id = ${analogId} AND verified = true
      AND (expires_at IS NULL OR expires_at > now())
    -- Current material first and newest-first inside it, because that is what
    -- makes a post timely. Human-vetted seeds lead the canonical block: someone
    -- actually read or watched those.
    ORDER BY (tier = 'current') DESC,
             added_at DESC,
             (source_of = 'seed') DESC,
             array_length(key_facts, 1) DESC NULLS LAST,
             -- Deterministic tiebreak. Without it, rows that match on every key
             -- above come back in whatever order Postgres feels like, and the
             -- three SWIFT canonicals match on ALL of them (same added_at, same
             -- source_of, same fact count). That made the shelf reorder between
             -- renders and, worse, made the old 2-per-tier drafting cap drop a
             -- DIFFERENT canonical on each request.
             id DESC
  `;
}

// What the drafter gets: a couple of canonical rows for the mechanism plus the
// newest current rows for timeliness. Ordered canonical-first so the model reads
// the mechanism before the news.
export async function sourcesForDrafting(analogId: string): Promise<AnalogSource[]> {
  const all = await getSourcesFor(analogId);
  const canonical = all.filter((s) => s.tier === "canonical").slice(0, DRAFT_CANONICAL);
  const current = all
    .filter((s) => s.tier === "current")
    .sort((a, b) => (a.ageDays ?? 9999) - (b.ageDays ?? 9999))
    .slice(0, DRAFT_CURRENT);
  return [...canonical, ...current];
}

// Every source a draft could legitimately argue from, in shelf order.
//
// This is the read behind per-source drafting, and it deliberately has no cap
// per tier. The 2-canonical/2-current limit above exists because a blended
// prompt gets vaguer the more sources you cram into it — but when each source
// gets its own call, that pressure disappears. The cap was also silently making
// sources undraftable: swift_messaging has 3 canonical rows, so one of them was
// listed on the shelf and could never be drafted from.
export async function draftableSources(analogId: string): Promise<AnalogSource[]> {
  const all = await getSourcesFor(analogId);
  return all.slice(0, MAX_FANOUT_SOURCES);
}

// One source by id, for a draft grounded in that piece alone.
//
// analogId is required and checked, not decorative: the id arrives from the
// browser, and a row from another concept would produce a post that teaches one
// mechanism while citing a source about a different one.
export async function getSourceById(id: number, analogId: string): Promise<AnalogSource | null> {
  const rows = await sql<AnalogSource>`
    SELECT id, analog_id AS "analogId", title, publisher, url, kind,
           published_on AS "publishedOn", summary, key_facts AS "keyFacts",
           verified, source_of AS "sourceOf", tier, facts_source AS "factsSource",
           text_doc_id AS "textDocId",
           EXTRACT(DAY FROM now() - added_at)::int AS "ageDays"
    FROM analog_sources
    WHERE id = ${id} AND analog_id = ${analogId} AND verified = true
      AND (expires_at IS NULL OR expires_at > now())
  `;
  return rows[0] ?? null;
}

// One round trip for the whole shelf, so the Prioritize page doesn't fire twenty
// queries to render twenty rows.
export async function getAllSources(): Promise<Map<string, AnalogSource[]>> {
  const rows = await sql<AnalogSource>`
    SELECT id, analog_id AS "analogId", title, publisher, url, kind,
           published_on AS "publishedOn", summary, key_facts AS "keyFacts",
           verified, source_of AS "sourceOf", tier, facts_source AS "factsSource",
           text_doc_id AS "textDocId",
           EXTRACT(DAY FROM now() - added_at)::int AS "ageDays"
    FROM analog_sources
    WHERE verified = true AND (expires_at IS NULL OR expires_at > now())
    ORDER BY analog_id, (tier = 'current') DESC, added_at DESC,
             (source_of = 'seed') DESC, array_length(key_facts, 1) DESC NULLS LAST,
             id DESC
  `;
  const map = new Map<string, AnalogSource[]>();
  for (const r of rows) {
    const list = map.get(r.analogId) ?? [];
    list.push(r);
    map.set(r.analogId, list);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

// HEAD first (cheap), then GET, because a surprising number of publishers —
// and YouTube — answer HEAD with 405 while serving GET fine. A 403 is treated
// as reachable: Cloudflare and several research desks block unknown clients but
// the page is genuinely there for a person with a browser.
async function urlResolves(url: string): Promise<{ ok: boolean; status: number | null }> {
  const headers = {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  };
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const res = await fetch(url, { method, headers, redirect: "follow", signal: AbortSignal.timeout(15_000) });
      if (res.ok || res.status === 403) return { ok: true, status: res.status };
      if (method === "GET") return { ok: false, status: res.status };
    } catch {
      if (method === "GET") return { ok: false, status: null };
    }
  }
  return { ok: false, status: null };
}

// ---------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------

function buildPrompt(def: AnalogDef, have: AnalogSource[], count: number): string {
  const exclusion = have.length
    ? `\nWe ALREADY have these — find different ones:\n${have.map((s) => `- ${s.title} (${s.url})`).join("\n")}\n`
    : "";

  return `Find authoritative SOURCE MATERIAL that explains one traditional finance mechanism. This will be cited publicly, so accuracy matters more than volume.

THE CONCEPT: ${def.label}
What it is: ${def.parallel}
Vocabulary: ${def.vocab.join(", ")}
${exclusion}
WHAT COUNTS AS A GOOD SOURCE, best first:
1. The institution that RUNS the mechanism explaining it themselves — a central bank, BIS, DTCC, SWIFT, CLS, a national payments authority, a regulator. These are unimpeachable and rarely used well.
2. A serious research desk, standards body, or industry primer (BIS, IMF, Fed, McKinsey, a payments consultancy).
3. A well-made explainer video or conference talk from a practitioner.
4. Trade press, only when it carries specific reported numbers.

AVOID: vendor marketing that exists to sell a product, SEO content farms, anything paywalled to the point of being uncheckable, and Wikipedia.

For each source give me the CHECKABLE CLAIMS a post could argue from — specific mechanisms, numbers, dates, named systems. Not vibes. If a piece has no specific claims, do not return it.

Return ONLY a JSON object (no prose, no code fences):
{"sources":[{
  "title":"the actual title of the piece",
  "publisher":"institution or outlet, e.g. \\"Bank for International Settlements\\"",
  "url":"https://real-url-you-actually-found",
  "kind":"article" | "report" | "video" | "primer" | "standard" | "regulation",
  "publishedOn":"YYYY or YYYY-MM, empty if unknown",
  "summary":"1-2 sentences: what this piece actually says about the mechanism",
  "keyFacts":["a specific checkable claim from the piece","another one"]
}]}
Return at most ${count}. Every URL must be one you actually found — a citation that 404s is worse than no citation, and these are checked.`;
}

interface RawSource {
  title: string;
  publisher: string;
  url: string;
  kind: string;
  publishedOn: string;
  summary: string;
  keyFacts: string[];
}

function parseSources(text: string): RawSource[] {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) return [];
  try {
    const obj = JSON.parse(t.slice(start, end + 1));
    const list = Array.isArray(obj?.sources) ? obj.sources : [];
    const KINDS = ["article", "report", "video", "primer", "standard", "regulation"];
    return list
      .map((s: Record<string, unknown>) => ({
        title: String(s.title ?? "").trim(),
        publisher: String(s.publisher ?? "").trim(),
        url: String(s.url ?? "").trim(),
        kind: KINDS.includes(s.kind as string) ? String(s.kind) : "article",
        publishedOn: String(s.publishedOn ?? "").trim(),
        summary: String(s.summary ?? "").trim(),
        keyFacts: Array.isArray(s.keyFacts) ? s.keyFacts.map((f: unknown) => String(f).trim()).filter(Boolean) : [],
      }))
      .filter((s: RawSource) => s.title && /^https?:\/\//i.test(s.url));
  } catch {
    return [];
  }
}

export interface FindSourcesResult {
  added: number;
  rejected: { url: string; title: string; status: number | null }[];
  sources: AnalogSource[];
  warnings: string[];
}

export async function findSourcesFor(analogId: string, count = 4): Promise<FindSourcesResult> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("XAI_API_KEY is not set");
  const def = ANALOG_BY_ID[analogId];
  if (!def) throw new Error(`Unknown concept: ${analogId}`);

  const have = await getSourcesFor(analogId);
  const warnings: string[] = [];

  const res = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    signal: AbortSignal.timeout(200_000),
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: XAI_MODEL,
      stream: false,
      input: [{ role: "user", content: buildPrompt(def, have, count) }],
      tools: [{ type: "web_search" }],
    }),
  });
  if (!res.ok) throw new Error(`xAI ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  const output: unknown[] = Array.isArray(data.output) ? data.output : [];
  const message = output.find(
    (o): o is { type?: string; content: { type: string; text?: string }[] } =>
      typeof o === "object" && o !== null && (o as { type?: string }).type === "message",
  );
  const block = message?.content?.find((c) => c.type === "output_text");
  const candidates = parseSources(block?.text ?? "");

  if (!candidates.length) warnings.push("No candidates came back from the search.");

  // Verify every URL before it is allowed anywhere near a draft.
  const checked = await Promise.all(
    candidates.map(async (c) => ({ c, check: await urlResolves(c.url) })),
  );

  const rejected: FindSourcesResult["rejected"] = [];
  let added = 0;
  for (const { c, check } of checked) {
    if (!check.ok) {
      rejected.push({ url: c.url, title: c.title, status: check.status });
      continue;
    }
    await sql`
      INSERT INTO analog_sources (analog_id, title, publisher, url, kind, published_on, summary, key_facts,
                                  verified, http_status, checked_at, source_of)
      VALUES (${analogId}, ${c.title}, ${c.publisher || null}, ${c.url}, ${c.kind},
              ${c.publishedOn || null}, ${c.summary || null}, ${c.keyFacts},
              true, ${check.status}, now(), 'grok')
      ON CONFLICT (analog_id, url) DO UPDATE SET
        title = EXCLUDED.title,
        publisher = COALESCE(EXCLUDED.publisher, analog_sources.publisher),
        summary = COALESCE(EXCLUDED.summary, analog_sources.summary),
        key_facts = CASE WHEN array_length(EXCLUDED.key_facts, 1) > 0
                         THEN EXCLUDED.key_facts ELSE analog_sources.key_facts END,
        verified = true, http_status = EXCLUDED.http_status, checked_at = now(),
        updated_at = now()
    `;
    added++;
  }

  if (rejected.length) {
    warnings.push(
      `${rejected.length} candidate${rejected.length === 1 ? "" : "s"} dropped — the URL did not resolve.`,
    );
  }

  return { added, rejected, sources: await getSourcesFor(analogId), warnings };
}

// ---------------------------------------------------------------------------
// Seeding
//
// The hand-curated sources on AnalogDef — the pieces Rob and I actually read or
// watched — go in as source_of='seed' and sort first everywhere. They are the
// only ones we know first-hand are good.
// ---------------------------------------------------------------------------
export async function seedRegistrySources(): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  for (const def of ANALOG_DEFS) {
    for (const s of def.sources ?? []) {
      const check = await urlResolves(s.url);
      if (!check.ok) {
        skipped++;
        continue;
      }
      // Seed titles are written "Publisher — Title" (e.g. "NINX — Smart Order
      // Routing Explained Simply"), so split the credit out rather than
      // rendering the whole string as a title with no attribution.
      const dash = s.title.indexOf(" — ");
      const publisher = dash > 0 ? s.title.slice(0, dash).trim() : null;
      const title = dash > 0 ? s.title.slice(dash + 3).trim() : s.title;
      await sql`
        INSERT INTO analog_sources (analog_id, title, publisher, url, kind, verified, http_status, checked_at, source_of)
        VALUES (${def.id}, ${title}, ${publisher}, ${s.url},
                ${s.url.includes("youtube.com") || s.url.includes("youtu.be") ? "video" : "article"},
                true, ${check.status}, now(), 'seed')
        ON CONFLICT (analog_id, url) DO UPDATE SET
          title = EXCLUDED.title, publisher = EXCLUDED.publisher,
          source_of = 'seed', verified = true, http_status = EXCLUDED.http_status,
          checked_at = now(), updated_at = now()
      `;
      inserted++;
    }
  }
  return { inserted, skipped };
}

// ---------------------------------------------------------------------------
// Grounding: the full text behind a source.
//
// A source row is metadata. This is the piece itself, and it is what the
// drafter must argue from. `textDocId IS NULL` is not an edge case to work
// around — it is the gate (migration 013).
// ---------------------------------------------------------------------------

export interface SourceText {
  docId: number;
  body: string;
  segments: { speaker?: string; start_sec?: number; end_sec?: number; text: string }[] | null;
  fetchedAt: string;
}

export async function getSourceText(source: Pick<AnalogSource, "textDocId">): Promise<SourceText | null> {
  if (!source.textDocId) return null;
  const rows = await sql<SourceText>`
    SELECT id AS "docId", body, segments, fetched_at AS "fetchedAt"
    FROM raw_documents
    WHERE id = ${source.textDocId}
  `;
  const row = rows[0];
  // A dangling pointer is the same risk as no pointer: treat it as ungrounded
  // rather than letting an empty body through as "verified".
  if (!row || !row.body || row.body.trim().length < 400) return null;
  return row;
}

/** True when this source can be drafted from at all. */
export function isGrounded(s: AnalogSource): boolean {
  return s.textDocId != null;
}
