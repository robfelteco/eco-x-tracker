import Anthropic from "@anthropic-ai/sdk";
import { sql } from "./db.ts";
import { discover, type DiscoveredItem } from "./discover.ts";
import { ANALOG_BY_ID, detectAnalog } from "./analogs.ts";
import { SITE_AUDIENCES, SITE_AUDIENCE_BY_ID, siteAudiencePromptBlock } from "./icp.ts";
import { ECO_ONE_LINER } from "./positioning.ts";
import { sanitizePrompt, stripDashes } from "./antiSlop.ts";
import type { CopyOption } from "./generateCopy.ts";

// The Broad Educational intake: stock the inbox, then keep the pipeline honest.
//
// Phase 2 of docs/BROAD-ED-REDESIGN.md. Before this, the pillar's card had a
// Discover button whose results lived in React state: gone on reload, never
// deduped across runs, impossible to bank, draft or mark posted. And the
// angle bank it was supposed to feed had zero rows after six weeks, because a
// blank seven-field form is not something anyone fills in at 9am.
//
// So the work moves to a nightly cron and the operator's job shrinks to a
// thirty-second read. For every candidate this module:
//
//   1. DEDUPES against what @eco has already posted (the no-reshare rule, by
//      resolved URL) and against every prior candidate, including skipped
//      ones. A skip is remembered forever; it never comes back.
//   2. SCRAPES the piece with Firecrawl into raw_documents, so the grounding
//      gates in lib/generateCopy.ts have text to check claims against. A
//      candidate we could not scrape is still shown, with Draft disabled and
//      the reason on the card, rather than silently dropped.
//   3. TAGS a curriculum concept via detectAnalog() when a mechanism is in
//      play, so the concept's parallel and break ride into the drafter.
//   4. Makes ONE Claude call that returns the audience, an adjacency score
//      against the eco.com themes, and the four angle-bank fields PRE-FILLED
//      (frame, mechanism, Eco bridge, evidence). The operator edits a frame
//      instead of writing one. The pick itself is never automated: Jay's call
//      on 2 Sep was that the FRAME step stays human, and the design doc keeps
//      it that way on purpose.
//
// Cost per candidate: 1 Firecrawl credit + one short Claude call. A nightly run
// is ~10-15 candidates, so the budget is the same order as the analog sweep.

// Same model knob as the drafter, for the same reason: one place to change it.
const MODEL = process.env.INTAKE_MODEL || process.env.COPY_MODEL || "claude-sonnet-4-6";
const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";

export type CandidateStatus = "inbox" | "picked" | "drafted" | "posted" | "skipped";
export const CANDIDATE_STATUSES: CandidateStatus[] = ["inbox", "picked", "drafted", "posted", "skipped"];

// The eco.com themes an educational post can imply (design doc §2). The intake
// model picks one per candidate; the UI shows it as the fourth word on the
// card. Kept as a list so the rubric and the UI cannot drift apart.
export const EDU_THEMES = [
  { id: "fragmentation", label: "Fragmentation", brief: "Liquidity, chains, venues and rails split into pieces that do not talk to each other." },
  { id: "pre_funding", label: "Pre-funding", brief: "Capital parked in advance (nostro, prefunded wallets, inventory) to make a payment or fill possible." },
  { id: "all_or_nothing", label: "All-or-nothing", brief: "Failsafe execution: every step confirms or nothing executes. PvP, DvP, atomic settlement, stranded funds." },
  { id: "programmable_rules", label: "Programmable rules", brief: "Policies and guardrails enforced in the money movement itself, not by a back office after the fact." },
  { id: "tokenized_assets", label: "Tokenized assets", brief: "RWAs, tokenized deposits, funds and securities moving on the same rails as stablecoins." },
  { id: "at_par", label: "At-par conversion", brief: "1:1 stablecoin-to-stablecoin and stablecoin-to-fiat conversion, signed quotes, no slippage." },
  { id: "agents", label: "Agents", brief: "Software agents that transact: bounded authority, machine-readable rails, outcomes enforced onchain." },
] as const;
export type EduTheme = (typeof EDU_THEMES)[number]["id"];
const THEME_BY_ID: Record<string, (typeof EDU_THEMES)[number]> = Object.fromEntries(EDU_THEMES.map((t) => [t.id, t]));

export function themeLabel(id: string | null | undefined): string | null {
  if (!id) return null;
  return THEME_BY_ID[id]?.label ?? id;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface EduCandidate {
  id: number;
  headline: string;
  summary: string | null;
  keyStat: string | null;
  sourceUrl: string;
  sourceTitle: string | null;
  publisher: string | null;
  publishedAt: string | null;
  origin: string;
  rawDocumentId: number | null;
  analogId: string | null;
  analogLabel: string | null;
  audience: string | null;
  adjacencyScore: number;
  adjacencyReasons: string[];
  theme: string | null;
  frame: string | null;
  mechanism: string | null;
  ecoBridge: string | null;
  evidence: string | null;
  status: CandidateStatus;
  drafts: CopyOption[] | null;
  draftedAt: string | null;
  usedPostId: string | null;
  usedPostUrl: string | null;
  usedPostImpressions: number | null;
  postedAt: string | null;
  pickedAt: string | null;
  createdAt: string;
  /** Days since the candidate was created. The inbox is ranked by adjacency, this is the tiebreak. */
  ageDays: number;
}

export interface EduPipeline {
  inbox: EduCandidate[];
  picked: EduCandidate[];
  drafted: EduCandidate[];
  posted: EduCandidate[];
  skipped: number;
  /** Concept ids with no teaching post yet, for the "mechanisms never taught" chip. */
  untaughtAnalogIds: string[];
  lastRun: {
    startedAt: string;
    finishedAt: string | null;
    trigger: string;
    added: number;
    scanned: number;
    deduped: number;
    scrapeFailed: number;
    error: string | null;
    warnings: string[];
  } | null;
}

type Raw = Omit<EduCandidate, "analogLabel" | "drafts"> & { drafts: unknown };

// The Neon driver hands timestamptz columns back as Date objects, not the ISO
// strings the interface promises, and the first UI draft died on
// `publishedAt.slice is not a function`. Normalised once, here, so every
// consumer (the drafter, the card, JSON responses) sees one shape.
function iso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function hydrate(r: Raw): EduCandidate {
  return {
    ...r,
    publishedAt: iso(r.publishedAt),
    draftedAt: iso(r.draftedAt),
    postedAt: iso(r.postedAt),
    pickedAt: iso(r.pickedAt),
    createdAt: iso(r.createdAt) ?? "",
    id: Number(r.id),
    rawDocumentId: r.rawDocumentId == null ? null : Number(r.rawDocumentId),
    adjacencyScore: Number(r.adjacencyScore ?? 0),
    usedPostImpressions: r.usedPostImpressions == null ? null : Number(r.usedPostImpressions),
    analogLabel: r.analogId ? (ANALOG_BY_ID[r.analogId]?.label ?? r.analogId) : null,
    drafts: Array.isArray(r.drafts) ? (r.drafts as CopyOption[]) : null,
  };
}

// One SELECT for both reads. The neon tagged template cannot splice a raw SQL
// fragment, so instead of duplicating forty lines of column aliases the two
// callers share this and narrow with parameters: a null id means "the board",
// an id means "this row".
async function selectCandidates(id: number | null): Promise<Raw[]> {
  return sql<Raw>`
    SELECT c.id::int AS id, c.headline, c.summary, c.key_stat AS "keyStat",
           c.source_url AS "sourceUrl", c.source_title AS "sourceTitle", c.publisher,
           c.published_at AS "publishedAt", c.origin,
           c.raw_document_id::int AS "rawDocumentId", c.analog_id AS "analogId",
           c.audience, c.adjacency_score AS "adjacencyScore",
           c.adjacency_reasons AS "adjacencyReasons", c.theme,
           c.frame, c.mechanism, c.eco_bridge AS "ecoBridge", c.evidence,
           c.status, c.drafts, c.drafted_at AS "draftedAt",
           c.used_post_id AS "usedPostId", p.url AS "usedPostUrl",
           (SELECT impressions FROM metric_snapshots m
             WHERE m.post_id = p.id ORDER BY fetched_at DESC LIMIT 1) AS "usedPostImpressions",
           c.posted_at AS "postedAt", c.picked_at AS "pickedAt", c.created_at AS "createdAt",
           EXTRACT(DAY FROM now() - c.created_at)::int AS "ageDays"
    FROM edu_candidates c
    LEFT JOIN posts p ON p.id = c.used_post_id
    WHERE (${id}::bigint IS NULL OR c.id = ${id}::bigint)
      AND (${id}::bigint IS NOT NULL OR c.status <> 'skipped')
    ORDER BY
      CASE c.status WHEN 'inbox' THEN 0 WHEN 'picked' THEN 1 WHEN 'drafted' THEN 2 ELSE 3 END,
      -- Inbox by adjacency; everything downstream by when it moved, newest first.
      CASE WHEN c.status = 'inbox' THEN c.adjacency_score ELSE 0 END DESC,
      c.updated_at DESC
    LIMIT 200`;
}

// The whole board in one read. Posted is capped: it is a record, not a queue,
// and the card is not the place to scroll three months of history.
export async function getEduPipeline(): Promise<EduPipeline> {
  const [rows, skippedRows, untaught, runs] = await Promise.all([
    selectCandidates(null),
    sql<{ n: number }>`SELECT count(*)::int AS n FROM edu_candidates WHERE status = 'skipped'`,
    // Same definition of "taught" as lib/curriculum.ts: a post in a teaching
    // pillar carrying the analog id. Computed here rather than imported so this
    // module stays usable from the cron without pulling the whole shelf.
    sql<{ analog_id: string }>`
      SELECT DISTINCT analog_id FROM posts
      WHERE analog_id IS NOT NULL AND is_reply = false
        AND template::text IN ('broad_educational', 'thought_leadership')`,
    sql<NonNullable<EduPipeline["lastRun"]>>`
      SELECT started_at AS "startedAt", finished_at AS "finishedAt", trigger, added, scanned,
             deduped, scrape_failed AS "scrapeFailed", error, warnings
      FROM edu_intake_runs ORDER BY started_at DESC LIMIT 1`,
  ]);
  const all = rows.map(hydrate);
  const taught = new Set(untaught.map((r) => r.analog_id));
  return {
    inbox: all.filter((c) => c.status === "inbox"),
    picked: all.filter((c) => c.status === "picked"),
    drafted: all.filter((c) => c.status === "drafted"),
    posted: all.filter((c) => c.status === "posted").slice(0, 20),
    skipped: Number(skippedRows[0]?.n ?? 0),
    untaughtAnalogIds: Object.keys(ANALOG_BY_ID).filter((id) => !taught.has(id)),
    lastRun: runs[0] ?? null,
  };
}

export async function getEduCandidate(id: number): Promise<EduCandidate | null> {
  const rows = await selectCandidates(id);
  return rows[0] ? hydrate(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

const nz = (v: string | null | undefined, max = 2000): string | null => {
  const t = (v ?? "").trim();
  return t ? t.slice(0, max) : null;
};

export interface CandidateEdit {
  frame?: string | null;
  mechanism?: string | null;
  ecoBridge?: string | null;
  evidence?: string | null;
  audience?: string | null;
  analogId?: string | null;
}

/** Edit the four frame fields and the audience. Only the keys present change. */
export async function updateEduCandidate(id: number, edit: CandidateEdit): Promise<void> {
  const cur = await getEduCandidate(id);
  if (!cur) throw new Error(`No candidate #${id}`);
  const audience = edit.audience === undefined ? cur.audience : edit.audience && SITE_AUDIENCE_BY_ID[edit.audience] ? edit.audience : null;
  const analogId = edit.analogId === undefined ? cur.analogId : edit.analogId && ANALOG_BY_ID[edit.analogId] ? edit.analogId : null;
  await sql`
    UPDATE edu_candidates SET
      frame      = ${edit.frame === undefined ? cur.frame : nz(edit.frame, 400)},
      mechanism  = ${edit.mechanism === undefined ? cur.mechanism : nz(edit.mechanism, 600)},
      eco_bridge = ${edit.ecoBridge === undefined ? cur.ecoBridge : nz(edit.ecoBridge, 600)},
      evidence   = ${edit.evidence === undefined ? cur.evidence : nz(edit.evidence, 600)},
      audience   = ${audience},
      analog_id  = ${analogId},
      updated_at = now()
    WHERE id = ${id}`;
}

/**
 * Move a candidate between states.
 *
 * Forward moves set their timestamp. A move back to inbox (un-pick) clears
 * drafts on purpose: a draft was written against a frame the operator has
 * just decided not to run, so keeping it would only invite posting it anyway.
 * 'posted' takes an optional post id; usually the post is not in `posts` yet
 * (it lands at the next sync), and the URL match there fills it in.
 */
export async function setEduCandidateStatus(
  id: number,
  status: CandidateStatus,
  postId?: string | null,
): Promise<void> {
  if (!CANDIDATE_STATUSES.includes(status)) throw new Error(`Bad status ${status}`);
  await sql`
    UPDATE edu_candidates SET
      status       = ${status},
      picked_at    = CASE WHEN ${status} = 'picked' THEN now() ELSE picked_at END,
      skipped_at   = CASE WHEN ${status} = 'skipped' THEN now() ELSE skipped_at END,
      posted_at    = CASE WHEN ${status} = 'posted' THEN now() WHEN ${status} IN ('inbox','picked','drafted') THEN NULL ELSE posted_at END,
      used_post_id = CASE WHEN ${status} = 'posted' THEN COALESCE(${postId ?? null}, used_post_id)
                          WHEN ${status} IN ('inbox','picked','drafted') THEN NULL ELSE used_post_id END,
      drafts       = CASE WHEN ${status} = 'inbox' THEN NULL ELSE drafts END,
      drafted_at   = CASE WHEN ${status} = 'inbox' THEN NULL ELSE drafted_at END,
      updated_at   = now()
    WHERE id = ${id}`;
}

/** Persist the drafter's output and advance to 'drafted'. */
export async function saveEduDrafts(id: number, drafts: CopyOption[]): Promise<void> {
  await sql`
    UPDATE edu_candidates SET
      drafts = ${JSON.stringify(drafts.slice(0, 3))}::jsonb,
      drafted_at = now(),
      status = CASE WHEN status IN ('inbox','picked','drafted') THEN 'drafted' ELSE status END,
      updated_at = now()
    WHERE id = ${id}`;
}

// ---------------------------------------------------------------------------
// URL identity
//
// The dedupe key. Lowercase host, scheme dropped, www. dropped, tracking params
// dropped, fragment dropped, trailing slash dropped. Grok and the sweep both
// return the same piece under different utm_ tails, and @eco's own link cards
// resolve through Buffer with utm params about half the time, so a byte-equal
// comparison would miss most real duplicates.
// ---------------------------------------------------------------------------
const DROP_PARAMS = /^(utm_|fbclid|gclid|mc_cid|mc_eid|ref$|source$|igshid|s$|t$)/i;

export function sourceKey(url: string): string {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const keep = [...u.searchParams.entries()].filter(([k]) => !DROP_PARAMS.test(k)).sort();
    const qs = keep.length ? "?" + keep.map(([k, v]) => `${k}=${v}`).join("&") : "";
    const path = u.pathname.replace(/\/+$/, "") || "";
    return `${host}${path}${qs}`;
  } catch {
    return url.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function isVideoUrl(url: string): boolean {
  return /youtube\.com|youtu\.be|spotify\.com|podcasts\.apple\.com/i.test(url);
}

// Same shape scripts/ingest-analog-sources.ts and lib/quoteLanes.ts use, so a
// URL scraped by any of the three lands on ONE raw_documents row.
function hashUrl(u: string): string {
  let h = 0;
  for (let i = 0; i < u.length; i++) h = (Math.imul(31, h) + u.charCodeAt(i)) | 0;
  return `web_${(h >>> 0).toString(36)}_${u.length}`;
}

function safeDate(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  const year = new Date(t).getUTCFullYear();
  return year >= 1990 && year <= 2100 ? new Date(t).toISOString() : null;
}

// ---------------------------------------------------------------------------
// Scrape
// ---------------------------------------------------------------------------

async function firecrawlScrape(url: string): Promise<{ markdown: string; title?: string; published?: string }> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error("FIRECRAWL_API_KEY is not set");
  const res = await fetch(`${FIRECRAWL_BASE}/scrape`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Firecrawl scrape ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  return {
    markdown: String(data?.data?.markdown ?? ""),
    title: data?.data?.metadata?.title,
    published: data?.data?.metadata?.publishedTime,
  };
}

// Scrape into raw_documents, or reuse the row an earlier ingest already made
// for this URL. Returns null when there is nothing citable on the page.
async function ensureDocument(url: string): Promise<{ docId: number; body: string; title: string | null; published: string | null } | null> {
  const existing = await sql<{ id: number; body: string; title: string | null; published_at: string | null }>`
    SELECT id, body, title, published_at FROM raw_documents
    WHERE source_kind = 'article' AND external_id = ${hashUrl(url)}
    LIMIT 1`;
  if (existing[0] && existing[0].body.trim().length >= 400) {
    const e = existing[0];
    return { docId: Number(e.id), body: e.body, title: e.title, published: e.published_at };
  }
  const { markdown, title, published } = await firecrawlScrape(url);
  if (markdown.trim().length < 400) return null;
  const rows = await sql<{ id: number }>`
    INSERT INTO raw_documents (source_kind, source_url, external_id, published_at, title, body, segments)
    VALUES ('article', ${url}, ${hashUrl(url)}, ${safeDate(published)}, ${title ?? null}, ${markdown}, NULL)
    ON CONFLICT (source_kind, external_id)
      DO UPDATE SET body = EXCLUDED.body, title = COALESCE(EXCLUDED.title, raw_documents.title), fetched_at = now()
    RETURNING id`;
  return { docId: Number(rows[0].id), body: markdown, title: title ?? null, published: safeDate(published) };
}

// ---------------------------------------------------------------------------
// The one Claude call: audience, adjacency, pre-filled frame.
// ---------------------------------------------------------------------------

interface Framing {
  audience: string;
  theme: string | null;
  score: number;
  reasons: string[];
  frame: string;
  mechanism: string | null;
  ecoBridge: string | null;
  evidence: string | null;
}

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
    _client = new Anthropic();
  }
  return _client;
}

const FRAMING_SYSTEM = `You are the research desk for @eco's educational X posts. ${ECO_ONE_LINER}

You read a piece of market news or research and decide how useful it is as the raw material for a BROAD EDUCATIONAL post: top-of-funnel, Eco never named in the body, the reader finishes smarter about how money moves. The best posts in this pillar name an institution, carry one number, and give one line of so-what that implies Eco's thesis without stating it.

You return JSON and nothing else.`;

function framingPrompt(input: {
  headline: string;
  summary: string | null;
  keyStat: string | null;
  sourceTitle: string | null;
  publisher: string | null;
  url: string;
  analog: { label: string; parallel: string; breaksWhere: string } | null;
  body: string;
}): string {
  return [
    `THE PIECE`,
    `Headline / angle: ${input.headline}`,
    input.summary ? `Summary: ${input.summary}` : null,
    input.keyStat ? `Key stat: ${input.keyStat}` : null,
    `Source: ${[input.publisher, input.sourceTitle].filter(Boolean).join(", ") || input.url}`,
    `URL: ${input.url}`,
    ``,
    `TEXT (excerpt of the scraped piece; the only evidence you have):`,
    `"""${input.body.slice(0, 6000)}"""`,
    ``,
    input.analog
      ? [
          `A CURRICULUM CONCEPT is detected in this piece: ${input.analog.label}.`,
          `Our framing of the parallel: ${input.analog.parallel}`,
          `Where it breaks: ${input.analog.breaksWhere}`,
          `Use it only if the piece genuinely bears on it. The mechanism field should name it when so.`,
          ``,
        ].join("\n")
      : null,
    `THE SIX AUDIENCES (pick exactly one id):`,
    siteAudiencePromptBlock(),
    ``,
    `THE SEVEN THEMES an educational post can imply (pick the one the piece most naturally implies, or null):`,
    EDU_THEMES.map((t) => `- ${t.id}: ${t.label}. ${t.brief}`).join("\n"),
    ``,
    `ADJACENCY SCORE, 0-100: how directly does this piece let a reader infer one of those themes without Eco being named?`,
    `  80-100: a named institution, a hard number, and the so-what IS one of the themes (e.g. a bank publishing pre-funding costs).`,
    `  50-79: clearly in the stablecoin/payments/tokenization market and a theme is one honest step away.`,
    `  20-49: in the market but the bridge would be a stretch; token price, exchange drama, generic adoption cheer.`,
    `  0-19: off-topic, promotional, or unverifiable.`,
    `Give 1-3 short reasons, each a plain sentence a colleague could argue with.`,
    ``,
    `PRE-FILL THE FRAME. These are a starting point an operator will edit, not a finished post:`,
    `  frame: the post angle in one line, as you would pitch it to an editor. Specific, with the number if there is one.`,
    `  mechanism: the thing being explained, in a sentence (the TradFi or market mechanism, named).`,
    `  ecoBridge: how this gets to what Eco does, WITHOUT naming Eco: the property the reader should infer (failsafe settlement, no pre-funding, programmable rules, at-par conversion, one layer across fragmented markets). One sentence. Say "no clear bridge" if there is not one.`,
    `  evidence: the exact quotable fact from the text, with the number, that the post would rest on. Copy it closely from the text.`,
    ``,
    `Return ONLY this JSON object, no prose, no code fences:`,
    `{"audience":"<one of the six ids>","theme":"<one of the seven ids or null>","score":<0-100>,"reasons":["..."],"frame":"...","mechanism":"...","ecoBridge":"...","evidence":"..."}`,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

function parseFraming(raw: string): Framing | null {
  let t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    const o = JSON.parse(t.slice(start, end + 1)) as Record<string, unknown>;
    const audience = SITE_AUDIENCE_BY_ID[String(o.audience)] ? String(o.audience) : SITE_AUDIENCES[0].id;
    const theme = THEME_BY_ID[String(o.theme)] ? String(o.theme) : null;
    const score = Math.max(0, Math.min(100, Math.round(Number(o.score) || 0)));
    const reasons = Array.isArray(o.reasons) ? o.reasons.map((r) => String(r).trim()).filter(Boolean).slice(0, 3) : [];
    // House rule applied at the door: the four fields are handed to the
    // drafter as the post's spine, and prompt style is imitated. The first
    // live run came back with an em dash in a third of the bridges.
    const clean = (v: unknown, max: number) => nz(stripDashes(String(v ?? "")), max);
    const frame = clean(o.frame, 400);
    if (!frame) return null;
    return {
      audience,
      theme,
      score,
      reasons: reasons.map((r) => stripDashes(r)),
      frame,
      mechanism: clean(o.mechanism, 600),
      ecoBridge: clean(o.ecoBridge, 600),
      evidence: clean(o.evidence, 600),
    };
  } catch {
    return null;
  }
}

async function frameCandidate(input: Parameters<typeof framingPrompt>[0]): Promise<Framing> {
  // Same backend as the drafter's API path. No CLI fallback here: this runs
  // inside a cron where there is no `claude` binary, and it is a short
  // classification-shaped call, not a drafting turn.
  const msg = await client().messages.create({
    model: MODEL,
    max_tokens: 1200,
    system: FRAMING_SYSTEM,
    messages: [{ role: "user", content: sanitizePrompt(framingPrompt(input)) }],
  });
  const text = msg.content.find((b) => b.type === "text");
  const parsed = parseFraming(text && text.type === "text" ? text.text : "");
  if (!parsed) throw new Error("framing call returned no usable JSON");
  const u = msg.usage;
  console.log(
    `[eduIntake] framed "${input.headline.slice(0, 50)}" score=${parsed.score} audience=${parsed.audience} ` +
      `(in=${u?.input_tokens ?? "?"} out=${u?.output_tokens ?? "?"})`,
  );
  return parsed;
}

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

interface Feed {
  headline: string;
  summary: string | null;
  keyStat: string | null;
  url: string;
  sourceTitle: string | null;
  publisher: string | null;
  publishedAt: string | null;
  origin: string;
  /** Pre-tagged concept, when the row came off the analog shelf. */
  analogId: string | null;
  /** A raw_documents row we already hold, when the sweep ingested the piece. */
  textDocId: number | null;
}

export interface IntakeResult {
  runId: number;
  scanned: number;
  added: number;
  deduped: number;
  scrapeFailed: number;
  credits: number;
  partial: boolean;
  warnings: string[];
  added_headlines: string[];
}

export interface IntakeOptions {
  trigger: "cron" | "manual";
  /** Epoch ms. The run stops taking new candidates past this and reports partial. */
  deadline?: number;
  /** Ceiling on Firecrawl scrapes, the only per-page cost. */
  maxScrapes?: number;
  /** Grok ideas per lens. Three lenses, so 4 is ~12 ideas a run. */
  perLens?: number;
  /** Newest current-tier analog sources to consider per run. */
  analogSources?: number;
  /** Skip the Grok lenses (cheaper re-run that only sweeps the analog shelf). */
  skipGrok?: boolean;
}

// What @eco has already pointed at, as normalised keys. The no-reshare rule,
// applied at the URL. Domains are deliberately NOT a hard exclusion: the
// account links bis.org and reuters.com dozens of times and always will, so a
// domain match says nothing about whether THIS piece has run. The domain count
// is surfaced on the card instead, as context.
async function postedKeys(): Promise<Set<string>> {
  const rows = await sql<{ u: string }>`
    SELECT lower(link_resolved_url) AS u FROM posts WHERE link_resolved_url IS NOT NULL AND is_reply = false
    UNION
    SELECT lower(u->>'expanded_url') AS u FROM posts, jsonb_array_elements(posts.urls) u
    WHERE is_reply = false AND u->>'expanded_url' IS NOT NULL`;
  const set = new Set<string>();
  for (const r of rows) if (r.u) set.add(sourceKey(r.u));
  return set;
}

async function candidateKeys(): Promise<Set<string>> {
  const rows = await sql<{ k: string }>`SELECT source_key AS k FROM edu_candidates`;
  return new Set(rows.map((r) => r.k));
}

async function grokFeed(perLens: number, warnings: string[]): Promise<Feed[]> {
  // Same exclude list the old /api/discover route built: titles of what the
  // pillar has already posted, so Grok hunts new territory.
  const posted = await sql<{ title: string }>`
    SELECT COALESCE(NULLIF(link_title, ''), left(text, 120)) AS title
    FROM posts
    WHERE template = 'broad_educational' AND is_reply = false
    ORDER BY created_at DESC
    LIMIT 60`;
  const { items, warnings: w } = await discover(posted.map((r) => r.title).filter(Boolean), perLens);
  warnings.push(...w);
  return items.map((it: DiscoveredItem) => ({
    headline: it.headline,
    summary: it.summary,
    keyStat: it.keyStat ?? null,
    url: it.source.url,
    sourceTitle: it.source.title || null,
    publisher: null,
    publishedAt: null,
    origin: `grok:${it.lens ?? "unknown"}`,
    analogId: null,
    textDocId: null,
  }));
}

// The current-tier analog sources the sweep already pulls in. News items
// tagged to a mechanism, which until now sat under a concept accordion where
// nobody saw them. Newest first, and only the ones not yet in the pipeline.
async function analogFeed(limit: number): Promise<Feed[]> {
  const rows = await sql<{
    analog_id: string; title: string; publisher: string | null; url: string;
    published_on: string | null; summary: string | null; key_facts: string[]; text_doc_id: number | null;
  }>`
    SELECT s.analog_id, s.title, s.publisher, s.url, s.published_on, s.summary, s.key_facts, s.text_doc_id
    FROM analog_sources s
    WHERE s.tier = 'current' AND s.verified = true
      AND (s.expires_at IS NULL OR s.expires_at > now())
      -- Video rows have no prose to scrape and are the podcast lane's job
      -- (Phase 3). On the first live run they were 12 of 24 rows and every one
      -- was skipped, so they are excluded at the read rather than in the loop.
      AND s.url NOT ILIKE '%youtube.com%' AND s.url NOT ILIKE '%youtu.be%'
    ORDER BY s.added_at DESC, s.id DESC
    LIMIT ${limit * 4}`;
  // Over-fetched on purpose: the dedupe against existing candidates happens in
  // the intake loop on the exact sourceKey(), and most of the newest rows will
  // already be in the pipeline after the first few runs. `analogCap` in the
  // loop is what bounds how many actually get taken.
  return rows.map((r) => ({
    headline: r.title,
    summary: r.summary,
    keyStat: r.key_facts?.[0] ?? null,
    url: r.url,
    sourceTitle: r.title,
    publisher: r.publisher,
    publishedAt: safeDate(r.published_on && /^\d{4}-\d{2}-\d{2}$/.test(r.published_on) ? r.published_on : null),
    origin: "analog_source",
    analogId: r.analog_id,
    textDocId: r.text_doc_id == null ? null : Number(r.text_doc_id),
  }));
}

export async function runEduIntake(opts: IntakeOptions): Promise<IntakeResult> {
  const deadline = opts.deadline ?? Date.now() + 240_000;
  const maxScrapes = opts.maxScrapes ?? 15;
  const warnings: string[] = [];
  const outOfTime = () => Date.now() > deadline;

  const run = await sql<{ id: number }>`
    INSERT INTO edu_intake_runs (trigger) VALUES (${opts.trigger}) RETURNING id`;
  const runId = Number(run[0].id);

  let scanned = 0;
  let added = 0;
  let deduped = 0;
  let scrapeFailed = 0;
  let credits = 0;
  let partial = false;
  const addedHeadlines: string[] = [];

  try {
    const [posted, known] = await Promise.all([postedKeys(), candidateKeys()]);

    const feeds: Feed[] = [];
    if (!opts.skipGrok) {
      try {
        feeds.push(...(await grokFeed(opts.perLens ?? 4, warnings)));
      } catch (e) {
        warnings.push(`grok lenses failed: ${String(e).slice(0, 140)}`);
      }
    }
    try {
      feeds.push(...(await analogFeed(opts.analogSources ?? 6)));
    } catch (e) {
      warnings.push(`analog shelf read failed: ${String(e).slice(0, 140)}`);
    }

    // Dedupe inside the run too: Grok's three lenses overlap, and a current
    // analog source can be the piece Grok also found.
    const seenThisRun = new Set<string>();
    let scrapes = 0;
    let analogTaken = 0;
    const analogCap = opts.analogSources ?? 6;

    for (const f of feeds) {
      if (!/^https?:\/\//i.test(f.url)) continue;
      scanned++;
      const key = sourceKey(f.url);
      if (seenThisRun.has(key) || known.has(key) || posted.has(key)) {
        deduped++;
        continue;
      }
      if (f.origin === "analog_source") {
        if (analogTaken >= analogCap) continue;
      }
      if (outOfTime()) {
        partial = true;
        warnings.push("out of time before finishing the feeds; the next run picks up the rest");
        break;
      }
      seenThisRun.add(key);

      // ---- text. Reuse what we hold, scrape otherwise. Video URLs cannot be
      // scraped into prose and are deferred to the podcast lane (Phase 3).
      let doc: Awaited<ReturnType<typeof ensureDocument>> = null;
      if (f.textDocId) {
        const held = await sql<{ id: number; body: string; title: string | null; published_at: string | null }>`
          SELECT id, body, title, published_at FROM raw_documents WHERE id = ${f.textDocId}`;
        if (held[0] && held[0].body.trim().length >= 400) {
          doc = { docId: Number(held[0].id), body: held[0].body, title: held[0].title, published: held[0].published_at };
        }
      }
      if (!doc && isVideoUrl(f.url)) {
        warnings.push(`${hostOf(f.url)}: video source skipped, no transcript to ground a draft in`);
        continue;
      }
      if (!doc) {
        if (scrapes >= maxScrapes) {
          partial = true;
          warnings.push("scrape budget reached; the rest waits for the next run");
          break;
        }
        try {
          scrapes++;
          credits++;
          doc = await ensureDocument(f.url);
          if (!doc) warnings.push(`${hostOf(f.url)}: too little content to cite`);
        } catch (e) {
          warnings.push(`${hostOf(f.url)}: ${String(e).slice(0, 100)}`);
        }
      }
      if (!doc) scrapeFailed++;

      // ---- concept tag. Headline + summary + the body's opening, so a piece
      // that buries its mechanism three paragraphs in still tags.
      const analogId =
        f.analogId ??
        detectAnalog([f.headline, f.summary ?? "", f.sourceTitle ?? "", (doc?.body ?? "").slice(0, 4000)].join("\n"));
      const analog = analogId ? ANALOG_BY_ID[analogId] : null;

      // ---- one Claude call. A candidate with no text still gets framed from
      // its summary, scored lower by the rubric for being unverifiable, and
      // shown with Draft disabled.
      let framing: Framing | null = null;
      try {
        framing = await frameCandidate({
          headline: f.headline,
          summary: f.summary,
          keyStat: f.keyStat,
          sourceTitle: f.sourceTitle ?? doc?.title ?? null,
          publisher: f.publisher,
          url: f.url,
          analog: analog ? { label: analog.label, parallel: analog.parallel, breaksWhere: analog.breaksWhere } : null,
          body: doc?.body ?? [f.summary, f.keyStat].filter(Boolean).join("\n") ?? "",
        });
      } catch (e) {
        warnings.push(`framing failed for "${f.headline.slice(0, 40)}": ${String(e).slice(0, 100)}`);
      }

      await sql`
        INSERT INTO edu_candidates
          (headline, summary, key_stat, source_url, source_key, source_title, publisher, published_at,
           origin, raw_document_id, analog_id, audience, adjacency_score, adjacency_reasons, theme,
           frame, mechanism, eco_bridge, evidence)
        VALUES
          (${f.headline.slice(0, 300)}, ${f.summary}, ${f.keyStat}, ${f.url}, ${key},
           ${f.sourceTitle ?? doc?.title ?? null}, ${f.publisher}, ${f.publishedAt ?? doc?.published ?? null},
           ${f.origin}, ${doc?.docId ?? null}, ${analogId}, ${framing?.audience ?? null},
           ${framing?.score ?? 0}, ${framing?.reasons ?? []}, ${framing?.theme ?? null},
           ${framing?.frame ?? null}, ${framing?.mechanism ?? null}, ${framing?.ecoBridge ?? null},
           ${framing?.evidence ?? null})
        ON CONFLICT (source_key) DO NOTHING`;
      known.add(key);
      added++;
      if (f.origin === "analog_source") analogTaken++;
      addedHeadlines.push(f.headline);
    }
  } catch (err) {
    await sql`
      UPDATE edu_intake_runs SET finished_at = now(), scanned = ${scanned}, added = ${added}, deduped = ${deduped},
        scrape_failed = ${scrapeFailed}, credits = ${credits}, warnings = ${warnings.slice(0, 20)},
        error = ${err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500)}
      WHERE id = ${runId}`;
    throw err;
  }

  await sql`
    UPDATE edu_intake_runs SET finished_at = now(), scanned = ${scanned}, added = ${added}, deduped = ${deduped},
      scrape_failed = ${scrapeFailed}, credits = ${credits}, warnings = ${warnings.slice(0, 20)}
    WHERE id = ${runId}`;

  return { runId, scanned, added, deduped, scrapeFailed, credits, partial, warnings, added_headlines: addedHeadlines };
}

// ---------------------------------------------------------------------------
// Closing the loop at sync.
//
// The same join lib/articleAttribution.ts does for Eco's own articles, pointed
// at the candidates: a new broad_educational post whose resolved link matches
// a candidate's source closes that candidate. Runs after every sync so the
// operator never re-enters what the account already published, and so a
// candidate posted straight from the composer (without Mark posted) still
// counts. Candidates in 'inbox' close too: posting it IS picking it.
// ---------------------------------------------------------------------------
export async function attributeEduCandidates(): Promise<{ matched: number }> {
  const open = await sql<{ id: number; source_key: string }>`
    SELECT id, source_key FROM edu_candidates
    WHERE used_post_id IS NULL AND status <> 'skipped'`;
  if (!open.length) return { matched: 0 };
  const byKey = new Map(open.map((c) => [c.source_key, Number(c.id)]));

  const posts = await sql<{ id: string; urls: string[] }>`
    SELECT id,
           COALESCE(ARRAY(SELECT lower(u->>'expanded_url') FROM jsonb_array_elements(posts.urls) u
                          WHERE u->>'expanded_url' IS NOT NULL), '{}'::text[])
             || CASE WHEN link_resolved_url IS NOT NULL THEN ARRAY[lower(link_resolved_url)] ELSE '{}'::text[] END
             AS urls
    FROM posts
    WHERE is_reply = false AND template::text = 'broad_educational'
      AND created_at > now() - interval '120 days'`;

  let matched = 0;
  for (const p of posts) {
    for (const u of p.urls) {
      const id = byKey.get(sourceKey(u));
      if (!id) continue;
      await sql`
        UPDATE edu_candidates SET status = 'posted', used_post_id = ${p.id},
          posted_at = COALESCE(posted_at, now()), updated_at = now()
        WHERE id = ${id} AND used_post_id IS NULL`;
      byKey.delete(sourceKey(u));
      matched++;
      break;
    }
  }
  return { matched };
}
