import { xGet, countBilledReads, resolveHandle } from "./twitter.ts";
import { sql } from "./db.ts";
import type { RosterPerson } from "./quoteRoster.ts";
import { transcribeVideo, segmentsToBody, VideoNotIngestedError, type Segment } from "./quoteExtract.ts";

// The three source lanes. Each one's job is the same: turn a source into rows in
// `raw_documents`. Extraction, verification and scoring happen downstream and
// identically for all three (lib/quoteDiscovery.ts).

export interface LaneDoc {
  sourceKind: "x_post" | "youtube" | "article" | "report";
  sourceUrl: string;
  externalId: string;
  publishedAt: string | null;
  title: string | null;
  body: string;
  segments: Segment[] | null;
  // Who we already know is in this source. Passed to extraction so it doesn't
  // have to infer an identity it can't see.
  knownSpeakers: string[];
  // Only set for the X lane, where the post IS the speaker's own words.
  personId?: number;
}

export interface LaneResult {
  docs: LaneDoc[];
  spendCents: number;
  warnings: string[];
  partial: boolean;
  // Set when the lane could not do its job at all. Distinct from "ran and found
  // nothing", which is a legitimate result and must not look like a failure.
  failed?: boolean;
}

// Called as a lane works through its items so the run can report what it is
// doing right now. Purely advisory — a lane never fails because reporting did.
export type LaneProgress = (done: number, total: number, note?: string) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Lane X — official API only (spec §5)
// ---------------------------------------------------------------------------
//
// The constraints drive the design rather than being routed around:
//   * pay-per-use, ~$0.005/post read and ~$0.010/user lookup — so author ids are
//     cached permanently and never re-resolved.
//   * recent search reaches back 7 days only, and full-archive is Enterprise —
//     so search CANNOT serve the 365-day lookback. It is used to find new NAMES,
//     not quotes.
//   * min_faves:/min_retweets: are silently ignored in v2 — so engagement
//     filtering happens locally, post-fetch.
// Historical depth comes from paginating roster user timelines, with since_id
// persisted per author so repeat runs are near-free.

const CENTS_PER_POST_READ = 0.5;
const CENTS_PER_USER_LOOKUP = 1.0;
const MAX_PAGES_PER_AUTHOR = 3; // 300 posts. Deep backfill is a deliberate admin action, not a Discover click.

// Never let one author monopolise a run. The first live run spent its whole
// budget on the first three people on the roster and returned a queue that was
// 14/15 the same executive — technically a success, editorially useless. Budget
// is now allocated as a FAIR SHARE across the roster, so a run reaches everyone
// shallowly rather than three people deeply. Depth accumulates for free across
// runs anyway: since_id is persisted per author, so the second run re-reads
// nobody and spends its whole budget on new posts.
const MIN_CENTS_PER_AUTHOR = 5; // one page of ~10 posts; below this a slot is pointless

// Engagement floors by org tier. A Citi MD at 400 followers still counts; a
// crypto account at 50k does not clear the same bar.
const MIN_ENGAGEMENT_BY_TIER: Record<number, number> = { 1: 2, 2: 8, 3: 25 };

const STABLECOIN_KEYWORDS = [
  "stablecoin", "usdc", "usdt", "digital dollar", "tokenized deposit", "settlement",
  "clearing", "orchestration", "payment rail", "onchain payment", "treasury",
  "cross-border", "remittance", "custody", "tokenization", "rwa", "genius act", "mica",
];

interface RawSearchTweet {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  note_tweet?: { text?: string };
  public_metrics?: { like_count?: number; reply_count?: number; retweet_count?: number; quote_count?: number };
  referenced_tweets?: { type: string }[];
}

interface RawUser {
  id: string;
  name: string;
  username: string;
  description?: string;
  public_metrics?: { followers_count?: number };
}

function hasStablecoinKeyword(text: string): boolean {
  const t = text.toLowerCase();
  return STABLECOIN_KEYWORDS.some((k) => t.includes(k));
}

export async function runLaneX(
  roster: RosterPerson[],
  opts: { lookbackDays: number; budgetCents: number; onProgress?: LaneProgress },
): Promise<LaneResult> {
  const warnings: string[] = [];
  const docs: LaneDoc[] = [];
  let spendCents = 0;
  let partial = false;

  const startTime = new Date(Date.now() - opts.lookbackDays * 86_400_000).toISOString();
  const people = roster.filter((p) => p.xHandle);

  // Fair share, floored so we don't hand out unusable slivers. If the budget
  // can't cover the whole roster at the floor, we cover as many people as it
  // can and say so — rather than silently going deep on whoever sorts first.
  const perAuthorCents = Math.max(MIN_CENTS_PER_AUTHOR, Math.floor(opts.budgetCents / Math.max(1, people.length)));
  const reachable = Math.floor(opts.budgetCents / perAuthorCents);
  if (reachable < people.length) {
    warnings.push(
      `Budget covers ${reachable} of ${people.length} rostered people at ${perAuthorCents}c each. ` +
        `Everyone else is skipped this run — since_id means the next run picks up where this one stopped.`,
    );
  }

  // Start each run at a different point in the roster so repeat runs don't keep
  // favouring the same names. Rotates on the count of authors already fetched.
  const startIdx = await rosterRotationOffset(people.length);
  const ordered = [...people.slice(startIdx), ...people.slice(0, startIdx)];

  let seen = 0;
  for (const p of ordered) {
    await opts.onProgress?.(seen++, ordered.length, p.fullName);
    // Abort at 90% of budget rather than overshooting (spec §5.3).
    if (spendCents >= opts.budgetCents * 0.9) {
      partial = true;
      warnings.push(`Budget reached — stopped before ${p.fullName} and everyone after them.`);
      break;
    }
    // This author's slice of the budget. Keeps one prolific account from eating
    // the run.
    const authorCeiling = spendCents + perAuthorCents;

    let authorId = p.xAuthorId;
    if (!authorId) {
      try {
        const u = await resolveHandle(p.xHandle!);
        authorId = u.id;
        spendCents += CENTS_PER_USER_LOOKUP;
        // Cache permanently. This is the single largest avoidable cost.
        await sql`UPDATE people SET x_author_id = ${authorId}, handles_verified_at = now() WHERE id = ${p.id}`;
      } catch (err) {
        warnings.push(`${p.fullName} (@${p.xHandle}): handle did not resolve — ${short(err)}`);
        continue;
      }
    }

    let pageToken: string | undefined;
    let newestId: string | null = null;
    let pages = 0;
    try {
      while (pages++ < MAX_PAGES_PER_AUTHOR) {
        // Size the page to what's actually left, instead of always asking for
        // 100 and checking the budget afterwards. A $1.00 run overshot to $1.11
        // because one full page landed after the ceiling was already reached —
        // billing is per POST RETURNED, so the only way to bound it is to ask
        // for fewer posts.
        const centsLeft = Math.min(authorCeiling - spendCents, opts.budgetCents * 0.9 - spendCents);
        const affordable = Math.floor(centsLeft / CENTS_PER_POST_READ);
        if (affordable < 5) break; // not enough left to be worth a round-trip
        const params: Record<string, string> = {
          // The API floor is 5 and the ceiling is 100.
          max_results: String(Math.max(5, Math.min(100, affordable))),
          exclude: "retweets,replies",
          // note_tweet is REQUIRED: posts over 280 chars carry their full text
          // there and a truncated version in `text`. The long ones are usually
          // the quotable ones, so missing this silently truncates the best
          // candidates.
          "tweet.fields": "created_at,public_metrics,note_tweet,referenced_tweets,entities,lang",
          expansions: "author_id",
          "user.fields": "name,username,description,verified,public_metrics",
        };
        if (p.xSinceId) params.since_id = p.xSinceId;
        else params.start_time = startTime;
        if (pageToken) params.pagination_token = pageToken;

        const data = await xGet<{ data?: RawSearchTweet[]; meta?: { next_token?: string } }>(
          `/users/${authorId}/tweets`,
          params,
        );
        const tweets = data.data ?? [];
        if (!tweets.length) break;
        countBilledReads(tweets.length);
        spendCents += tweets.length * CENTS_PER_POST_READ;
        if (!newestId) newestId = tweets[0].id;

        for (const t of tweets) {
          const text = t.note_tweet?.text || t.text;
          if (!passesLocalFilter(t, text, p.orgTier)) continue;
          docs.push({
            sourceKind: "x_post",
            sourceUrl: `https://x.com/${p.xHandle}/status/${t.id}`,
            externalId: t.id,
            publishedAt: t.created_at ?? null,
            title: null,
            body: text,
            segments: null,
            knownSpeakers: [p.fullName],
            personId: p.id,
          });
        }

        pageToken = data.meta?.next_token;
        if (!pageToken) break;
        if (spendCents >= authorCeiling) break; // this author's share is spent
        if (spendCents >= opts.budgetCents * 0.9) {
          partial = true;
          break;
        }
      }
      // Persist since_id per author after a successful pass — second run onward
      // is near-free.
      if (newestId) await sql`UPDATE people SET x_since_id = ${newestId} WHERE id = ${p.id}`;
    } catch (err) {
      warnings.push(`${p.fullName}: timeline fetch failed — ${short(err)}`);
      if (/credits depleted|spend cap|401/i.test(String(err))) {
        partial = true;
        warnings.push("Aborting Lane X — the X API refused further reads.");
        break;
      }
    }
  }

  await opts.onProgress?.(ordered.length, ordered.length);
  return { docs, spendCents, warnings, partial };
}

// Server-side engagement filters don't work in v2, so this runs locally on what
// came back (spec §5.4).
function passesLocalFilter(t: RawSearchTweet, text: string, orgTier: number | null): boolean {
  const m = t.public_metrics ?? {};
  const engagement = (m.like_count ?? 0) + (m.reply_count ?? 0) + (m.retweet_count ?? 0) + (m.quote_count ?? 0);
  const floor = MIN_ENGAGEMENT_BY_TIER[orgTier ?? 3] ?? 25;
  if (engagement < floor) return false;
  // Replies and quote-posts with little original text are reaction, not a quote.
  const isReferencing = (t.referenced_tweets ?? []).some((r) => r.type === "replied_to" || r.type === "quoted");
  if (isReferencing && text.replace(/https?:\/\/\S+/g, "").trim().length < 120) return false;
  if (!hasStablecoinKeyword(text)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Roster discovery — the 7-day keyword sweep (spec §5.5)
// ---------------------------------------------------------------------------
//
// Results are NOT quote candidates. The sweep exists to surface NAMES we don't
// have yet, so the expensive read budget stays pointed at people we've vetted.

export async function sweepForRosterNames(
  queries: string[],
  knownHandles: Set<string>,
  budgetCents: number,
  onProgress?: LaneProgress,
): Promise<{ found: number; spendCents: number; warnings: string[] }> {
  const warnings: string[] = [];
  let spendCents = 0;
  let found = 0;

  let done = 0;
  for (const q of queries) {
    await onProgress?.(done++, queries.length, q.slice(0, 48));
    if (spendCents >= budgetCents) break;
    try {
      const data = await xGet<{ data?: RawSearchTweet[]; includes?: { users?: RawUser[] } }>(
        "/tweets/search/recent",
        {
          query: q,
          max_results: "100",
          "tweet.fields": "created_at,public_metrics,note_tweet,author_id",
          expansions: "author_id",
          "user.fields": "name,username,description,public_metrics",
        },
      );
      const tweets = data.data ?? [];
      countBilledReads(tweets.length);
      spendCents += tweets.length * CENTS_PER_POST_READ;

      const users = new Map((data.includes?.users ?? []).map((u) => [u.id, u]));
      for (const t of tweets) {
        const u = t.author_id ? users.get(t.author_id) : null;
        if (!u) continue;
        if (knownHandles.has(u.username.toLowerCase())) continue;
        const text = t.note_tweet?.text || t.text;
        await sql`
          INSERT INTO roster_suggestions (x_handle, x_author_id, display_name, bio, followers, sample_post, sample_url)
          VALUES (${u.username}, ${u.id}, ${u.name}, ${u.description ?? null},
                  ${u.public_metrics?.followers_count ?? null}, ${text.slice(0, 400)},
                  ${`https://x.com/${u.username}/status/${t.id}`})
          ON CONFLICT (x_handle) DO UPDATE
            SET seen_count = roster_suggestions.seen_count + 1, last_seen_at = now()`;
        found++;
      }
    } catch (err) {
      warnings.push(`roster sweep "${q.slice(0, 40)}…" failed — ${short(err)}`);
    }
  }
  return { found, spendCents, warnings };
}

// ---------------------------------------------------------------------------
// Lane YouTube — Gemini direct (spec §6)
// ---------------------------------------------------------------------------
//
// YouTube URLs go straight to Gemini as a file_data part. No transcript
// scraping, no yt-dlp, no caption library. Public videos only.

export interface VideoTarget {
  videoId: string;
  url: string;
  title: string | null;
  publishedAt: string | null;
  durationSec: number | null;
  participants: string[];
}

export async function runLaneYouTube(videos: VideoTarget[], onProgress?: LaneProgress): Promise<LaneResult> {
  const warnings: string[] = [];
  const docs: LaneDoc[] = [];

  let done = 0;
  for (const v of videos) {
    await onProgress?.(done++, videos.length, v.title ?? v.videoId);
    try {
      const segments = await transcribeVideo(v.url, v.participants, v.durationSec);
      if (!segments.length) {
        warnings.push(`${v.title ?? v.videoId}: transcription returned nothing (private or unlisted?)`);
        continue;
      }
      docs.push({
        sourceKind: "youtube",
        sourceUrl: v.url,
        externalId: v.videoId,
        publishedAt: v.publishedAt,
        title: v.title,
        body: segmentsToBody(segments),
        segments,
        // Only speakers Gemini could name. A null-speaker segment is ineligible
        // to produce a candidate, so it contributes no known speaker either.
        knownSpeakers: [...new Set(segments.map((s) => s.speaker_name).filter((n): n is string => !!n))],
      });
    } catch (err) {
      warnings.push(`${v.title ?? v.videoId}: ${short(err)}`);
      // If the model can't actually read video, it will fail identically for
      // every remaining item — and the failure mode is INVENTED transcripts, so
      // this must stop the lane and mark it failed rather than quietly return
      // nothing (which reads as "no quotes found today").
      if (err instanceof VideoNotIngestedError) {
        warnings.push(
          "Aborting Lane YouTube — this Gemini key/model tier is not ingesting YouTube video. " +
            "Anything it returned would be fabricated, so nothing from this lane is trusted.",
        );
        return { docs: [], spendCents: 0, warnings, partial: true, failed: true };
      }
      if (/GEMINI_API_KEY|401|quota|PERMISSION_DENIED/i.test(String(err))) {
        warnings.push("Aborting Lane YouTube — Gemini refused further requests.");
        return { docs, spendCents: 0, warnings, partial: true, failed: true };
      }
    }
  }
  await onProgress?.(videos.length, videos.length);
  return { docs, spendCents: 0, warnings, partial: false };
}

// Resolve an @handle (or a bare channel name) to a real channelId. This matters:
// the obvious `search?q=bankless` returns anything matching the WORD bankless,
// including unrelated accounts' videos, and the lane would then pay Gemini to
// transcribe a stranger's reel. Always resolve, then scope the listing.
const channelIdCache = new Map<string, string>();

export async function resolveYouTubeChannel(handleOrId: string): Promise<string | null> {
  if (handleOrId.startsWith("UC")) return handleOrId;
  const cached = channelIdCache.get(handleOrId);
  if (cached) return cached;

  const key = ytKey();
  const handle = handleOrId.startsWith("@") ? handleOrId : `@${handleOrId}`;
  const tryParams = [
    new URLSearchParams({ key, part: "id", forHandle: handle }),
    new URLSearchParams({ key, part: "id", forUsername: handleOrId.replace(/^@/, "") }),
  ];
  for (const params of tryParams) {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?${params}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) continue;
    const data = await res.json();
    const id = data?.items?.[0]?.id;
    if (id) {
      channelIdCache.set(handleOrId, id);
      return id;
    }
  }
  return null;
}

// List a channel's uploads since a date. Uses the YouTube Data API only for
// cheap LISTING — Gemini does all comprehension (spec §6.1).
export async function listChannelUploads(
  channelHandleOrId: string,
  sinceIso: string,
  max = 5,
): Promise<VideoTarget[]> {
  const key = ytKey();
  const channelId = await resolveYouTubeChannel(channelHandleOrId);
  if (!channelId) throw new Error(`could not resolve channel "${channelHandleOrId}"`);

  const params = new URLSearchParams({
    key,
    part: "snippet",
    channelId, // scoped to THIS channel — never a free-text search
    order: "date",
    type: "video",
    maxResults: String(max),
    publishedAfter: sinceIso,
  });

  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`YouTube API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const ids: string[] = (data.items ?? [])
    .map((i: { id?: { videoId?: string } }) => i.id?.videoId)
    .filter(Boolean);
  if (!ids.length) return [];

  // The search snippet truncates the description, and the description is where
  // the guest list lives — which is what makes diarization attributable. So
  // fetch the full snippets in one batched call.
  const detail = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?${new URLSearchParams({
      key,
      part: "snippet,contentDetails",
      id: ids.join(","),
    })}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!detail.ok) throw new Error(`YouTube API ${detail.status}: ${(await detail.text()).slice(0, 200)}`);
  const detailData = await detail.json();

  return (detailData.items ?? []).map(
    (v: {
      id: string;
      snippet: { title: string; publishedAt: string; description: string };
      contentDetails?: { duration?: string };
    }) => ({
      videoId: v.id,
      url: `https://www.youtube.com/watch?v=${v.id}`,
      title: decodeHtml(v.snippet.title),
      publishedAt: v.snippet.publishedAt,
      durationSec: parseIso8601Duration(v.contentDetails?.duration),
      participants: extractParticipants(v.snippet.description ?? ""),
    }),
  );
}

function ytKey(): string {
  const k = process.env.YOUTUBE_API_KEY;
  if (!k) throw new Error("YOUTUBE_API_KEY is not set");
  return k;
}

// The API returns HTML-encoded titles ("What&#39;s Next").
function decodeHtml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// PT1H23M45S -> seconds. Used to skip Shorts (which are never a panel or an
// interview) and to warn on anything long enough to be expensive.
export function parseIso8601Duration(d: string | undefined): number | null {
  if (!d) return null;
  const m = d.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

function extractParticipants(description: string): string[] {
  const names = new Set<string>();
  // "with Jane Doe", "guest: Jane Doe", "Jane Doe, CEO of X"
  const re = /(?:with|guest[s]?:|featuring|joined by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z'-]+){1,2})/g;
  for (const m of description.matchAll(re)) names.add(m[1]);
  const titled = /([A-Z][a-z]+(?:\s+[A-Z][a-z'-]+){1,2}),\s+(?:CEO|CTO|COO|CFO|Head of|President|Founder|Partner|VP|SVP|Managing Director)/g;
  for (const m of description.matchAll(titled)) names.add(m[1]);
  return [...names].slice(0, 10);
}

// ---------------------------------------------------------------------------
// Lane Web — Firecrawl (spec §7)
// ---------------------------------------------------------------------------
//
// Institutional reports, earnings transcripts, conference recaps, show notes.
// Firecrawl is the wrong tool for YouTube and X — it is never pointed at either.

const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";

// Enumerate real article URLs under a report hub. Scraping the hub itself
// returns navigation and teaser text — the Chainalysis blog index scraped to
// 11k characters of cookie banners and headlines, with not one quotable
// sentence in it. `map` finds the actual pieces; those are what get scraped.
export async function mapReportHub(hubUrl: string, limit = 6): Promise<string[]> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return [];
  const res = await fetch(`${FIRECRAWL_BASE}/map`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ url: hubUrl, limit: 60 }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Firecrawl map ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const links: string[] = (data?.links ?? [])
    .map((l: string | { url?: string }) => (typeof l === "string" ? l : l?.url))
    .filter((u: unknown): u is string => typeof u === "string");

  // Compare on host+path with the leading "www." stripped. The watch_source
  // identifier is written without it ("chainalysis.com/blog") while Firecrawl
  // returns canonical URLs with it — a naive startsWith() then matches nothing
  // and the hub silently yields zero articles.
  const norm = (u: string) => {
    try {
      const p = new URL(u);
      return `${p.host.replace(/^www\./, "")}${p.pathname}`.replace(/\/+$/, "").toLowerCase();
    } catch {
      return u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "").toLowerCase();
    }
  };
  const hub = norm(hubUrl);

  return links
    // Keep only pages BELOW the hub — a hub's own nav links out to the whole site.
    .filter((u) => {
      const n = norm(u);
      return n !== hub && n.startsWith(`${hub}/`);
    })
    // Drop pagination, tags and category indexes; they're hubs too.
    .filter((u) => !/\/(page|tag|tags|category|categories|author)\//i.test(u))
    // Require a real slug, not a one-word section.
    .filter((u) => norm(u).slice(hub.length + 1).length > 8)
    .slice(0, limit);
}

export async function runLaneWeb(
  targets: { url: string; label?: string }[],
  onProgress?: LaneProgress,
): Promise<LaneResult> {
  const key = process.env.FIRECRAWL_API_KEY;
  const warnings: string[] = [];
  const docs: LaneDoc[] = [];
  if (!key) return { docs, spendCents: 0, warnings: ["FIRECRAWL_API_KEY is not set — web lane skipped."], partial: true };

  let done = 0;
  for (const t of targets) {
    await onProgress?.(done++, targets.length, t.label ?? t.url);
    if (/youtube\.com|youtu\.be|(^|\/\/)(x|twitter)\.com/i.test(t.url)) {
      warnings.push(`skipped ${t.url} — X and YouTube belong to their own lanes`);
      continue;
    }
    try {
      const res = await fetch(`${FIRECRAWL_BASE}/scrape`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ url: t.url, formats: ["markdown"], onlyMainContent: true }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`Firecrawl ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      const md: string = data?.data?.markdown ?? "";
      if (!md.trim()) {
        warnings.push(`${t.url}: no content extracted`);
        continue;
      }
      docs.push({
        sourceKind: "article",
        sourceUrl: t.url,
        externalId: hashUrl(t.url),
        publishedAt: data?.data?.metadata?.publishedTime ?? null,
        title: data?.data?.metadata?.title ?? t.label ?? null,
        body: md,
        segments: null,
        knownSpeakers: [],
      });
    } catch (err) {
      warnings.push(`${t.url}: ${short(err)}`);
    }
  }
  await onProgress?.(targets.length, targets.length);
  return { docs, spendCents: 0, warnings, partial: false };
}

// Deep link that lands the reviewer on the sentence, where the source supports
// it. A reviewer who has to go hunting for the quote is a run that failed.
export function webDeepLink(url: string, quote: string): string {
  const fragment = quote.split(/\s+/).slice(0, 8).join(" ");
  return `${url}#:~:text=${encodeURIComponent(fragment)}`;
}

export function youtubeDeepLink(url: string, startSec: number | null): string {
  if (startSec == null) return url;
  return `${url}${url.includes("?") ? "&" : "?"}t=${Math.max(0, Math.floor(startSec))}`;
}

function hashUrl(u: string): string {
  let h = 0;
  for (let i = 0; i < u.length; i++) h = (h * 31 + u.charCodeAt(i)) | 0;
  return `web_${(h >>> 0).toString(36)}`;
}

// Rotate the roster starting point per run, so run N+1 doesn't re-favour the
// same people run N happened to reach first.
async function rosterRotationOffset(size: number): Promise<number> {
  if (size <= 1) return 0;
  const rows = await sql<{ n: number }>`SELECT COUNT(*)::int AS n FROM discovery_runs`;
  return (rows[0]?.n ?? 0) % size;
}

function short(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 160);
}
