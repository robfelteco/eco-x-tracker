import Anthropic from "@anthropic-ai/sdk";
import { sql } from "./db.ts";
import { ANALOG_BY_ID, ANALOG_DEFS, type AnalogDef } from "./analogs.ts";
import { mapReportHub } from "./quoteLanes.ts";
import { CURRENT_RETENTION_DAYS } from "./analogSources.ts";

// The sweep — keeps the curriculum's evidence base fresh instead of frozen.
//
// The first pass sourced all twenty concepts and then stopped, and everything it
// found was evergreen: a BIS primer on RTGS explains the mechanism perfectly and
// will say the same thing in 2029. Correct, and useless for timeliness. This
// module goes looking for the other layer: this month's BIS quarterly, a Fed
// speech from last week, a conference talk from yesterday.
//
// WHY THIS IS NOT AN MCP CALL. MCP servers are tools in a Claude session; a
// Vercel function cannot reach them. It does not matter, because Firecrawl and
// YouTube are both REST APIs the app already calls with keys already in the
// environment (lib/quoteLanes.ts has been doing it for the quote lanes). Same
// keys, same patterns, new consumer.
//
// BUDGET IS THE DESIGN CONSTRAINT. Measured against the real account:
//   firecrawl search (limit<=10)  2 credits
//   firecrawl map                 1 credit, flat
//   firecrawl scrape              1 credit per page
// So one concept costs about 9 credits a sweep (2 searches, 1 hub map, up to 4
// scrapes). Twenty concepts daily would be ~180/day against a 5,000/cycle plan,
// which does not fit. Four a day costs ~36 and refreshes everything on a
// five-day cycle, and the scrape count falls after the first cycle because
// candidates are deduped against URLs we already hold.

const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";
const YT_API = "https://www.googleapis.com/youtube/v3";
const MODEL = process.env.SWEEP_MODEL || "claude-sonnet-4-6";

// Measured costs, used to report spend rather than guess at it.
const COST_SEARCH = 2;
const COST_MAP = 1;
const COST_SCRAPE = 1;

export interface SweepOptions {
  /** Stop starting new work past this timestamp. Vercel functions get killed. */
  deadline?: number;
  /** Hard cap on scrapes, the only per-page cost in the sweep. */
  maxScrapes?: number;
  /** Search the last N days. Matches the retention window by default. */
  lookbackDays?: number;
  includeVideo?: boolean;
}

export interface SweepResult {
  analogId: string;
  label: string;
  scanned: number;
  added: number;
  rejected: number;
  credits: number;
  warnings: string[];
  partial: boolean;
}

// ---------------------------------------------------------------------------
// Firecrawl
// ---------------------------------------------------------------------------

interface SearchHit {
  url: string;
  title: string;
  description: string;
  fromHub?: boolean;
}

// `tbs` is the whole point of using search rather than only the hubs: qdr:m
// scopes to the last month, which is what makes a result CURRENT rather than
// another evergreen primer we already have.
async function firecrawlSearch(query: string, tbs: string, limit = 10): Promise<SearchHit[]> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error("FIRECRAWL_API_KEY is not set");
  const res = await fetch(`${FIRECRAWL_BASE}/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ query, limit, tbs, sources: ["web", "news"] }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Firecrawl search ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  // v2 returns { data: { web: [...], news: [...] } } or a flat array depending
  // on the sources requested. Tolerate both rather than assuming one.
  const buckets = data?.data ?? {};
  const raw: unknown[] = Array.isArray(buckets)
    ? buckets
    : [...(buckets.web ?? []), ...(buckets.news ?? [])];
  return raw
    .map((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      return {
        url: String(o.url ?? "").trim(),
        title: String(o.title ?? "").trim(),
        description: String(o.description ?? o.snippet ?? "").trim(),
      };
    })
    .filter((h) => /^https?:\/\//i.test(h.url));
}

async function firecrawlScrape(url: string): Promise<{ markdown: string; title?: string; published?: string }> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error("FIRECRAWL_API_KEY is not set");
  const res = await fetch(`${FIRECRAWL_BASE}/scrape`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Firecrawl scrape ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  return {
    markdown: String(data?.data?.markdown ?? ""),
    title: data?.data?.metadata?.title,
    published: data?.data?.metadata?.publishedTime,
  };
}

// ---------------------------------------------------------------------------
// Query construction
//
// Two angles per concept, because one query returns one shape of result. The
// first is institutional ("what did an authority publish about this lately"),
// the second is operational ("what is the cost/problem people are writing
// about"). Both are scoped to the concept's own vocabulary so the results stay
// on the mechanism instead of drifting to crypto commentary.
// ---------------------------------------------------------------------------
function buildQueries(def: AnalogDef): string[] {
  const core = def.vocab.slice(0, 3).join(" OR ");
  // Both queries name institutions on purpose. Without that, terms like
  // "T+2 settlement" and "interchange fees" are commercially valuable keywords
  // and the results are almost entirely vendor lead-gen content.
  return [
    `${def.label} ${core} BIS OR "central bank" OR regulator report 2026`,
    `${def.label} ${core} statistics OR data OR "annual report" clearing house OR "payment system"`,
  ];
}

// Domains that are never worth a scrape: encyclopedic (we want primary sources),
// or aggregators that just restate a press release.
const SKIP_HOST = /(^|\.)(wikipedia\.org|investopedia\.com|reddit\.com|medium\.com|linkedin\.com|facebook\.com|x\.com|twitter\.com|youtube\.com|youtu\.be)$/i;

// Host authority, and the reason it exists: the first real run scanned 46
// candidates, scraped the first four, and kept none of them. Those four were
// vendor marketing (Thunes, Nuvei, a fintech consultancy's lead-gen blog),
// because search results were inserted before the hub URLs and the slice took
// them in insertion order. The extraction gate correctly rejected all four, so
// the sweep spent four scrapes to learn nothing.
//
// Scraping is the only per-page cost in the sweep, so what gets scraped FIRST is
// the whole efficiency question. Ranking by host solves it: an institution
// explaining its own mechanism is the best possible source and is knowable from
// the URL alone, before spending a credit.
const AUTHORITY = [
  /(^|\.)bis\.org$/i,
  /(^|\.)swift\.com$/i,
  /(^|\.)dtcc\.com$/i,
  /(^|\.)cls-group\.com$/i,
  /(^|\.)fixtrading\.org$/i,
  /(^|\.)europeanpaymentscouncil\.eu$/i,
  /(^|\.)iso\.org$/i,
  /(^|\.)imf\.org$/i,
  /(^|\.)fsb\.org$/i,
  /(^|\.)iosco\.org$/i,
  /\.gov$/i,
  /\.europa\.eu$/i,
  /(^|\.)bankofengland\.co\.uk$/i,
  /(^|\.)bundesbank\.de$/i,
  /(^|\.)banque-france\.fr$/i,
  /(^|\.)bankofcanada\.ca$/i,
  /(^|\.)rba\.gov\.au$/i,
  /(^|\.)bcb\.gov\.br$/i,
  /(^|\.)rbi\.org\.in$/i,
  /(^|\.)mas\.gov\.sg$/i,
];

// Listing pages. The European Payments Council hub handed back three of these
// in one production run and they ate three of that concept's four scrapes: the
// extraction gate rejected all three with "index/listing page with no checkable
// claims of its own", which is correct but costs a credit each to learn.
// mapReportHub already drops /page/ and /tag/ style paths; these are the section
// indexes that survive it.
const INDEX_PATH =
  /\/(news|press|press-?releases?|publ|publications?|insights?|articles?|blog|media|newsroom|resources?|library|events?|opinion|interviews?)\/?$/i;

// Higher sorts first. fromHub outranks everything because we chose that hub for
// this concept by hand, but an index page is worthless whatever it came from.
function authorityRank(url: string, fromHub: boolean): number {
  try {
    if (INDEX_PATH.test(new URL(url).pathname)) return -1;
  } catch {
    /* unparseable url, let the normal ranking handle it */
  }
  if (fromHub) return 3;
  const h = hostOf(url);
  if (AUTHORITY.some((re) => re.test(h))) return 2;
  // A research or standards path on an unknown host still beats a blog.
  if (/\/(publ|publications|research|statistics|rulebook|standards|press-?release)/i.test(url)) return 1;
  return 0;
}

function hostOf(u: string): string {
  try {
    return new URL(u).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function normUrl(u: string): string {
  try {
    const p = new URL(u);
    return `${p.host.replace(/^www\./, "")}${p.pathname}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return u.replace(/\/+$/, "").toLowerCase();
  }
}

// ---------------------------------------------------------------------------
// Extraction
//
// Firecrawl gets us a real page; this decides whether the page is worth citing
// and pulls the checkable claims out of it. The keep/reject gate matters as much
// as the extraction: a search for "interchange fees" surfaces a great deal of
// vendor marketing, and a vendor blog dressed up as a citation is exactly the
// kind of source that makes a teaching post embarrassing.
// ---------------------------------------------------------------------------
interface Extracted {
  url: string;
  keep: boolean;
  reason?: string;
  tier: "canonical" | "current";
  title: string;
  publisher: string;
  publishedOn: string;
  kind: string;
  summary: string;
  keyFacts: string[];
}

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
    _client = new Anthropic();
  }
  return _client;
}

async function extract(def: AnalogDef, docs: { url: string; markdown: string; hint?: string }[]): Promise<Extracted[]> {
  if (!docs.length) return [];
  const body = docs
    .map(
      (d, i) =>
        `=== DOC ${i + 1} ===\nURL: ${d.url}\n${d.hint ? `Search snippet: ${d.hint}\n` : ""}CONTENT:\n"""${d.markdown.slice(0, 9000)}"""`,
    )
    .join("\n\n");

  const prompt = `You are curating source material for educational posts about one traditional-finance mechanism. These sources get cited publicly, so a bad keep is worse than a miss.

THE MECHANISM: ${def.label}
What it is: ${def.parallel}
Vocabulary: ${def.vocab.join(", ")}

For each document decide whether to KEEP it as a citable source.

KEEP when the piece is from an institution that runs or regulates the mechanism (central bank, BIS, DTCC, SWIFT, CLS, a regulator, a national payments authority), a serious research desk or standards body, or trade press carrying specific reported numbers about this mechanism.

REJECT when it is vendor marketing that exists to sell a product, an SEO content farm, an encyclopedia entry, a listicle, or a page that mentions the mechanism only in passing and makes no checkable claim about it. REJECT anything about cryptocurrency prices or trading advice.

TIER each keeper:
  "canonical" — explains the mechanism itself and will still be true in five years (a primer, a standard, a rulebook, a system description).
  "current"   — reports something that happened or was measured recently (a quarterly report, a speech, new data, a migration deadline, a policy change). Anything with a 2026 date and a number is almost always current.

keyFacts must be CHECKABLE claims lifted from the document: specific numbers, named systems, dates, mechanisms. Never a paraphrase of the topic. If a document has no checkable claim, reject it.

${body}

Return ONLY a JSON object, no prose, no code fences:
{"docs":[{
  "url":"the URL exactly as given",
  "keep": true | false,
  "reason":"one short clause, required when keep is false",
  "tier":"canonical" | "current",
  "title":"the real title of the piece",
  "publisher":"the institution or outlet",
  "publishedOn":"YYYY or YYYY-MM or YYYY-MM-DD, empty if genuinely unknowable",
  "kind":"article" | "report" | "video" | "primer" | "standard" | "regulation",
  "summary":"1-2 sentences on what this piece says about the mechanism",
  "keyFacts":["checkable claim","checkable claim"]
}]}`;

  const msg = await client().messages.create({
    model: MODEL,
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });
  const out = msg.content.find((b) => b.type === "text");
  let t = (out && out.type === "text" ? out.text : "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const a = t.indexOf("{");
  const z = t.lastIndexOf("}");
  if (a === -1 || z === -1) return [];
  try {
    const obj = JSON.parse(t.slice(a, z + 1));
    const list = Array.isArray(obj?.docs) ? obj.docs : [];
    const KINDS = ["article", "report", "video", "primer", "standard", "regulation"];
    return list.map((d: Record<string, unknown>) => ({
      url: String(d.url ?? "").trim(),
      keep: d.keep === true,
      reason: d.reason ? String(d.reason).slice(0, 160) : undefined,
      tier: d.tier === "current" ? ("current" as const) : ("canonical" as const),
      title: String(d.title ?? "").trim(),
      publisher: String(d.publisher ?? "").trim(),
      publishedOn: String(d.publishedOn ?? "").trim(),
      kind: KINDS.includes(d.kind as string) ? String(d.kind) : "article",
      summary: String(d.summary ?? "").trim(),
      keyFacts: Array.isArray(d.keyFacts) ? d.keyFacts.map((f: unknown) => String(f).trim()).filter(Boolean) : [],
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function store(analogId: string, e: Extracted, factsSource: string): Promise<void> {
  // Canonical never expires. Current ages out of the "current" read after the
  // retention window but stays in the table, so we keep the history.
  const expires =
    e.tier === "current" ? new Date(Date.now() + CURRENT_RETENTION_DAYS * 86_400_000).toISOString() : null;
  await sql`
    INSERT INTO analog_sources (analog_id, title, publisher, url, kind, published_on, summary, key_facts,
                                verified, http_status, checked_at, source_of, tier, expires_at, facts_source)
    VALUES (${analogId}, ${e.title}, ${e.publisher || null}, ${e.url}, ${e.kind},
            ${e.publishedOn || null}, ${e.summary || null}, ${e.keyFacts},
            true, 200, now(), 'sweep', ${e.tier}, ${expires}, ${factsSource})
    ON CONFLICT (analog_id, url) DO UPDATE SET
      title = EXCLUDED.title,
      publisher = COALESCE(EXCLUDED.publisher, analog_sources.publisher),
      summary = COALESCE(EXCLUDED.summary, analog_sources.summary),
      key_facts = CASE WHEN array_length(EXCLUDED.key_facts, 1) > 0
                       THEN EXCLUDED.key_facts ELSE analog_sources.key_facts END,
      published_on = COALESCE(EXCLUDED.published_on, analog_sources.published_on),
      -- Never demote a hand-vetted seed to a swept row.
      tier = CASE WHEN analog_sources.source_of = 'seed' THEN analog_sources.tier ELSE EXCLUDED.tier END,
      expires_at = CASE WHEN analog_sources.source_of = 'seed' THEN analog_sources.expires_at ELSE EXCLUDED.expires_at END,
      verified = true, checked_at = now(), updated_at = now()
  `;
}

// ---------------------------------------------------------------------------
// YouTube lane
//
// Cheap in quota terms (search.list is 100 units of a 10,000/day allowance) and
// it reaches material the web lane cannot: conference talks, central-bank
// explainers, practitioner panels. Deliberately NOT transcribed — Gemini
// transcription would dominate the cost of the whole sweep — so facts come from
// the description and are labelled as such, and the drafter is told not to
// attribute a hard number to a talk we never listened to.
// ---------------------------------------------------------------------------
async function youtubeCandidates(def: AnalogDef, lookbackDays: number, limit = 4) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return [];
  const publishedAfter = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  const q = `${def.label} ${def.vocab.slice(0, 2).join(" ")} explained`;
  const sres = await fetch(
    `${YT_API}/search?${new URLSearchParams({
      key,
      part: "snippet",
      q,
      type: "video",
      maxResults: String(limit),
      order: "relevance",
      publishedAfter,
      relevanceLanguage: "en",
    })}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!sres.ok) throw new Error(`YouTube search ${sres.status}: ${(await sres.text()).slice(0, 160)}`);
  const sdata = await sres.json();
  return (sdata.items ?? [])
    .map((it: { id?: { videoId?: string }; snippet?: Record<string, string> }) => ({
      url: `https://www.youtube.com/watch?v=${it.id?.videoId}`,
      videoId: it.id?.videoId ?? "",
      title: it.snippet?.title ?? "",
      channel: it.snippet?.channelTitle ?? "",
      description: it.snippet?.description ?? "",
      publishedAt: it.snippet?.publishedAt ?? "",
    }))
    .filter((v: { videoId: string }) => v.videoId);
}

// ---------------------------------------------------------------------------
// One concept
// ---------------------------------------------------------------------------

export async function sweepConcept(analogId: string, opts: SweepOptions = {}): Promise<SweepResult> {
  const def = ANALOG_BY_ID[analogId];
  if (!def) throw new Error(`Unknown concept: ${analogId}`);
  const maxScrapes = opts.maxScrapes ?? 4;
  const lookbackDays = opts.lookbackDays ?? CURRENT_RETENTION_DAYS;
  const warnings: string[] = [];
  let credits = 0;
  let partial = false;

  const outOfTime = () => opts.deadline != null && Date.now() > opts.deadline;

  // Everything we already hold, so a repeat result never costs a scrape. This
  // is what makes the steady-state cost lower than the first cycle.
  const existing = await sql<{ url: string }>`SELECT url FROM analog_sources WHERE analog_id = ${analogId}`;
  const seen = new Set(existing.map((r) => normUrl(r.url)));

  // --- gather candidates ------------------------------------------------
  const hits = new Map<string, SearchHit>();

  // Time-scoped search. qdr:m when the caller wants the last month or less,
  // otherwise qdr:y, since a 365-day lookback wants the wider window.
  const tbs = lookbackDays <= 31 ? "qdr:m" : "qdr:y";
  for (const q of buildQueries(def)) {
    if (outOfTime()) {
      partial = true;
      break;
    }
    try {
      const found = await firecrawlSearch(q, tbs, 10);
      credits += COST_SEARCH;
      for (const h of found) hits.set(normUrl(h.url), h);
    } catch (err) {
      warnings.push(`search failed: ${String(err).slice(0, 120)}`);
    }
  }

  // Institutional hubs. `map` enumerates the real pieces under a hub; scraping
  // a hub directly returns navigation and teaser text.
  for (const hub of def.hubs ?? []) {
    if (outOfTime()) {
      partial = true;
      break;
    }
    try {
      const urls = await mapReportHub(hub, 8);
      credits += COST_MAP;
      for (const u of urls) {
        if (!hits.has(normUrl(u))) hits.set(normUrl(u), { url: u, title: "", description: "", fromHub: true });
      }
    } catch (err) {
      warnings.push(`hub ${hostOf(hub)}: ${String(err).slice(0, 100)}`);
    }
  }

  const candidates = [...hits.values()]
    .filter((h) => !seen.has(normUrl(h.url)))
    .filter((h) => !SKIP_HOST.test(hostOf(h.url)))
    // Drop listing pages outright rather than ranking them last: they are never
    // citable, so they should not be able to consume a scrape at all when the
    // authoritative candidates run thin.
    .filter((h) => authorityRank(h.url, !!h.fromHub) >= 0)
    // Spend the scrape budget on the most authoritative candidates, not on
    // whichever result the search engine happened to return first.
    .sort((a, b) => authorityRank(b.url, !!b.fromHub) - authorityRank(a.url, !!a.fromHub));
  const scanned = hits.size;

  // --- scrape, the only per-page cost ----------------------------------
  const docs: { url: string; markdown: string; hint?: string }[] = [];
  for (const c of candidates.slice(0, maxScrapes)) {
    if (outOfTime()) {
      partial = true;
      warnings.push("out of time before finishing scrapes; the next run picks up where this stopped");
      break;
    }
    try {
      const { markdown } = await firecrawlScrape(c.url);
      credits += COST_SCRAPE;
      // A successful scrape IS the URL verification, so no separate HEAD/GET.
      if (markdown.trim().length < 400) {
        warnings.push(`${hostOf(c.url)}: too little content to cite`);
        continue;
      }
      docs.push({ url: c.url, markdown, hint: c.description || undefined });
    } catch (err) {
      warnings.push(`${hostOf(c.url)}: ${String(err).slice(0, 100)}`);
    }
  }

  // --- video lane ------------------------------------------------------
  const videoDocs: { url: string; markdown: string; hint?: string }[] = [];
  if (opts.includeVideo !== false && !outOfTime()) {
    try {
      const vids = await youtubeCandidates(def, lookbackDays, 4);
      for (const v of vids.slice(0, 2)) {
        if (seen.has(normUrl(v.url))) continue;
        videoDocs.push({
          url: v.url,
          markdown: `TITLE: ${v.title}\nCHANNEL: ${v.channel}\nPUBLISHED: ${v.publishedAt}\nDESCRIPTION:\n${v.description}`,
          hint: "YouTube video. Facts come from the description only; it has not been transcribed.",
        });
      }
    } catch (err) {
      warnings.push(`youtube: ${String(err).slice(0, 120)}`);
    }
  }

  // --- extract + store -------------------------------------------------
  let added = 0;
  let rejected = 0;
  try {
    const [webEx, vidEx] = await Promise.all([
      extract(def, docs),
      videoDocs.length ? extract(def, videoDocs) : Promise.resolve([]),
    ]);
    for (const e of webEx) {
      if (!e.keep || !e.keyFacts.length) {
        rejected++;
        if (e.reason) warnings.push(`rejected ${hostOf(e.url)}: ${e.reason}`);
        continue;
      }
      await store(analogId, e, "body");
      added++;
    }
    for (const e of vidEx) {
      if (!e.keep || !e.keyFacts.length) {
        rejected++;
        continue;
      }
      await store(analogId, { ...e, kind: "video" }, "description");
      added++;
    }
  } catch (err) {
    warnings.push(`extraction failed: ${String(err).slice(0, 160)}`);
  }

  await sql`
    INSERT INTO analog_sweep_state (analog_id, last_swept_at, last_status, last_added, last_scanned, last_error, spend_credits)
    VALUES (${analogId}, now(), ${partial ? "partial" : "ok"}, ${added}, ${scanned},
            ${warnings.length ? warnings.slice(0, 3).join(" | ").slice(0, 500) : null}, ${credits})
    ON CONFLICT (analog_id) DO UPDATE SET
      last_swept_at = now(), last_status = EXCLUDED.last_status,
      last_added = EXCLUDED.last_added, last_scanned = EXCLUDED.last_scanned,
      last_error = EXCLUDED.last_error,
      spend_credits = analog_sweep_state.spend_credits + EXCLUDED.spend_credits,
      updated_at = now()
  `;

  return { analogId, label: def.label, scanned, added, rejected, credits, warnings, partial };
}

// ---------------------------------------------------------------------------
// The rotation
//
// Oldest-swept-first, N per run. This is the whole budget strategy: every
// concept gets refreshed on a predictable cycle without a fan-out that would
// burn the month's Firecrawl allowance in a week. Concepts never swept sort
// first, so a newly added concept is picked up on the next run.
// ---------------------------------------------------------------------------
export async function pickConceptsToSweep(count: number): Promise<string[]> {
  const rows = await sql<{ analogId: string }>`
    SELECT c.analog_id AS "analogId"
    FROM (SELECT unnest(${ANALOG_DEFS.map((d) => d.id)}::text[]) AS analog_id) c
    LEFT JOIN analog_sweep_state s ON s.analog_id = c.analog_id
    ORDER BY s.last_swept_at ASC NULLS FIRST
    LIMIT ${count}
  `;
  return rows.map((r) => r.analogId);
}

export interface SweepRunResult {
  results: SweepResult[];
  totalAdded: number;
  totalCredits: number;
  warnings: string[];
}

export async function runAnalogSweep(opts: SweepOptions & { concepts?: number } = {}): Promise<SweepRunResult> {
  const count = opts.concepts ?? 4;
  const ids = await pickConceptsToSweep(count);
  const results: SweepResult[] = [];
  const warnings: string[] = [];

  for (const id of ids) {
    if (opts.deadline != null && Date.now() > opts.deadline) {
      warnings.push(`Out of time with ${ids.length - results.length} concept(s) left; they sort first next run.`);
      break;
    }
    try {
      results.push(await sweepConcept(id, opts));
    } catch (err) {
      warnings.push(`${id}: ${String(err).slice(0, 160)}`);
      await sql`
        INSERT INTO analog_sweep_state (analog_id, last_swept_at, last_status, last_error)
        VALUES (${id}, now(), 'failed', ${String(err).slice(0, 500)})
        ON CONFLICT (analog_id) DO UPDATE SET
          last_swept_at = now(), last_status = 'failed', last_error = EXCLUDED.last_error, updated_at = now()
      `;
    }
  }

  return {
    results,
    totalAdded: results.reduce((n, r) => n + r.added, 0),
    totalCredits: results.reduce((n, r) => n + r.credits, 0),
    warnings,
  };
}
