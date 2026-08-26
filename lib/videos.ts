import { sql } from "./db.ts";
import { ICP_BY_ID } from "./icp.ts";

// The VIDEO layer — the shelf behind the Short-Form Video (Eco) pillar.
//
// The gap this exists to close: the @ecoprotocol YouTube channel holds 280
// clips of 180s or under. Fifty-eight have ever run on X. The pillar was on
// draftMode 'generic' — a single "draft something fresh" button — while roughly
// 220 finished, on-brand, already-produced clips sat unused because nothing in
// the tool knew they existed.
//
// TWO SOURCES, merged rather than chosen between:
//
//   youtube — the broad inventory. 280 shorts with a title, a genuine
//             paragraph-length summary in the description, and a view count.
//             This is what makes the shelf big.
//
//   dropbox — the team's delivery folder. Far fewer clips, but it carries two
//             things YouTube cannot: the FILE (a download link, so a clip can
//             go straight to X) and the team's own quality verdict, encoded in
//             the folder tree as "Weak (Don't Use)". A human already made that
//             call; the shelf must respect it rather than re-litigate it.
//
// A row may have either side or both. yt_video_id and dropbox_file_id are both
// nullable and either alone is a valid clip.
//
// DIRECTION, as with the docs shelf: registry-first. The valuable rows are the
// ones with no post attached.

const YT_API = "https://www.googleapis.com/youtube/v3";
export const ECO_YT_HANDLE = "@ecoprotocol";

// A "short" for our purposes. YouTube's own Shorts cutoff is 180s, and the
// pillar's posted clips run 17-179s, so the same bound is the right filter.
export const SHORT_MAX_SEC = 180;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VideoRow {
  id: number;
  ytVideoId: string | null;
  ytUrl: string | null;
  ytPublishedOn: string | null;
  ytViews: number | null;
  ytThumbUrl: string | null;
  dropboxFileId: string | null;
  dropboxPath: string | null;
  dropboxFolder: string | null;
  title: string;
  description: string | null;
  transcript: string | null;
  durationSec: number | null;
  series: string | null;
  speaker: string | null;
  icp: string | null;
  topic: string | null;
  hook: string | null;
  doNotUse: boolean;
}

export interface VideoShelfRow extends VideoRow {
  icpLabel: string | null;
  seriesLabel: string;
  speakerLabel: string | null;
  useCount: number;
  lastUsed: string | null;
  daysSinceLastUse: number | null;
  medianImpr: number | null;
  bestImpr: number | null;
  score: number;
  posts: VideoUse[];
  hasFile: boolean;
}

export interface VideoUse {
  id: string;
  url: string;
  createdAt: string;
  daysAgo: number;
  text: string;
  impressions: number | null;
}

// ---------------------------------------------------------------------------
// Series / speaker vocabulary
// ---------------------------------------------------------------------------

export const SERIES_DEFS: { id: string; label: string; hint: string }[] = [
  { id: "product_explainer", label: "Product explainer", hint: "Head of Product / team explaining a mechanism to camera" },
  { id: "ceo_interview", label: "CEO interview clip", hint: "A cut from a podcast or show appearance" },
  { id: "concept_101", label: "Concept 101", hint: "'What is X' educational explainer, no Eco pitch" },
  { id: "market_take", label: "Market take", hint: "Commentary on a stablecoin-market development" },
  { id: "brand_film", label: "Brand film", hint: "Produced brand/marketing piece, not a talking head" },
  { id: "demo", label: "Product demo", hint: "Screen or in-app footage" },
  { id: "third_party", label: "Third-party clip", hint: "Someone outside Eco saying something useful" },
];

export const SERIES_BY_ID = Object.fromEntries(SERIES_DEFS.map((s) => [s.id, s]));

export const SPEAKER_LABELS: Record<string, string> = {
  strao: "@strao_ (Head of Product)",
  rynesaxe: "@rynesaxe (CEO)",
  shah: "Shah",
  third_party: "External speaker",
  none: "No speaker / voiceover",
};

export function seriesLabel(id: string | null): string {
  if (!id) return "Untagged";
  return SERIES_BY_ID[id]?.label ?? id;
}

export function speakerLabel(id: string | null): string | null {
  if (!id) return null;
  return SPEAKER_LABELS[id] ?? id;
}

// ---------------------------------------------------------------------------
// YouTube sync
// ---------------------------------------------------------------------------

function ytKey(): string {
  const k = process.env.YOUTUBE_API_KEY;
  if (!k) throw new Error("YOUTUBE_API_KEY is not set");
  return k;
}

function decodeHtml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function parseIso8601Duration(d: string | undefined): number | null {
  if (!d) return null;
  const m = d.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const [, h, mi, s] = m;
  return (Number(h ?? 0) * 3600) + (Number(mi ?? 0) * 60) + Number(s ?? 0);
}

// YouTube descriptions carry a fixed promo footer on every upload. It is pure
// noise in a drafting prompt and it would dominate a title-similarity match, so
// it goes at ingest rather than at read time.
export function cleanDescription(d: string): string {
  return d
    .split(/\n\s*(?:Learn more at|Follow eco:)/i)[0]
    .replace(/https?:\/\/\S+/g, "")
    .trim();
}

export interface YtSyncResult {
  seen: number;
  shorts: number;
  inserted: number;
  updated: number;
  errors: string[];
}

async function ytJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`YouTube API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Walk the channel's uploads playlist (cheap, 1 unit/page) rather than paying
// 100 units a page for search.list, then batch-hydrate the details.
export async function syncYouTubeVideos(handle = ECO_YT_HANDLE): Promise<YtSyncResult> {
  const res: YtSyncResult = { seen: 0, shorts: 0, inserted: 0, updated: 0, errors: [] };
  const key = ytKey();

  const chan = (await ytJson(
    `${YT_API}/channels?${new URLSearchParams({ key, part: "contentDetails", forHandle: handle })}`,
  )) as { items?: { contentDetails?: { relatedPlaylists?: { uploads?: string } } }[] };
  const uploads = chan.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error(`could not resolve uploads playlist for ${handle}`);

  const ids: string[] = [];
  let token = "";
  do {
    const page = (await ytJson(
      `${YT_API}/playlistItems?${new URLSearchParams({
        key,
        part: "contentDetails",
        playlistId: uploads,
        maxResults: "50",
        ...(token ? { pageToken: token } : {}),
      })}`,
    )) as { items?: { contentDetails?: { videoId?: string } }[]; nextPageToken?: string };
    for (const it of page.items ?? []) if (it.contentDetails?.videoId) ids.push(it.contentDetails.videoId);
    token = page.nextPageToken ?? "";
  } while (token);
  res.seen = ids.length;

  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    let data: {
      items?: {
        id: string;
        snippet: {
          title: string;
          description: string;
          publishedAt: string;
          thumbnails?: Record<string, { url?: string }>;
        };
        contentDetails?: { duration?: string };
        statistics?: { viewCount?: string };
      }[];
    };
    try {
      data = (await ytJson(
        `${YT_API}/videos?${new URLSearchParams({
          key,
          part: "snippet,contentDetails,statistics",
          id: batch.join(","),
        })}`,
      )) as typeof data;
    } catch (e) {
      res.errors.push(e instanceof Error ? e.message : String(e));
      continue;
    }

    for (const v of data.items ?? []) {
      const dur = parseIso8601Duration(v.contentDetails?.duration);
      if (dur == null || dur > SHORT_MAX_SEC) continue; // long-form isn't this pillar
      res.shorts++;

      const thumb =
        v.snippet.thumbnails?.maxres?.url ??
        v.snippet.thumbnails?.standard?.url ??
        v.snippet.thumbnails?.high?.url ??
        v.snippet.thumbnails?.medium?.url ??
        null;

      const rows = await sql<{ inserted: boolean }>`
        INSERT INTO videos (
          yt_video_id, yt_url, yt_published_on, yt_views, yt_thumb_url,
          title, description, duration_sec, active
        ) VALUES (
          ${v.id},
          ${`https://www.youtube.com/watch?v=${v.id}`},
          ${v.snippet.publishedAt.slice(0, 10)},
          ${Number(v.statistics?.viewCount ?? 0)},
          ${thumb},
          ${decodeHtml(v.snippet.title)},
          ${cleanDescription(v.snippet.description ?? "")},
          ${dur},
          true
        )
        ON CONFLICT (yt_video_id) DO UPDATE SET
          yt_views = EXCLUDED.yt_views,
          yt_thumb_url = COALESCE(EXCLUDED.yt_thumb_url, videos.yt_thumb_url),
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          duration_sec = EXCLUDED.duration_sec,
          active = true,
          updated_at = now()
        RETURNING (xmax = 0) AS inserted`;
      if (rows[0]?.inserted) res.inserted++;
      else res.updated++;
    }
  }

  return res;
}

// ---------------------------------------------------------------------------
// Dropbox side
// ---------------------------------------------------------------------------

export interface DropboxVideoEntry {
  fileId: string;
  path: string;
  name: string;
  bytes: number;
  modified: string;
  transcript?: string | null;
}

export interface DropboxIngestResult {
  entries: number;
  mergedIntoYouTube: number;
  insertedNew: number;
  markedDoNotUse: number;
  transcripts: number;
}

// Turn "22-Eco is not A Bridge, it's Interop Protocol(vert).mp4" into something
// matchable and human-readable. The delivery filenames carry a leading sequence
// number, a "(vert)"/"-captioned" variant suffix, and the extension — all of
// which are packaging, not title.
export function cleanVideoFilename(name: string): string {
  return (
    name
      .replace(/\.[a-z0-9]+$/i, "")
      // Leading ISO date FIRST. Without this the sequence-number rule below
      // bites the century off "2026-07-09 - Shah 04" and leaves "6-07-09".
      .replace(/^\s*\d{4}[-_.]\d{2}[-_.]\d{2}\s*[-_.]?\s*/, "")
      .replace(/^\s*\d{1,3}\s*[-_.]?\s*/, "")
      .replace(/\(?\s*vert\s*\)?/gi, "")
      .replace(/[-_]?captioned/gi, "")
      .replace(/\.mp4/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

// True when a filename carries no subject at all — a delivery batch label like
// "Shah 04" or "Clip 2". These cannot be title-matched against a YouTube title
// by any metric, so they route to the content-based matcher instead of
// producing a confident-looking wrong answer.
export function isBatchLabel(cleaned: string): boolean {
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length <= 2 && /\d/.test(cleaned)) return true;
  return /^(shah|ryne|clip|cut|take|v)\s*\d+$/i.test(cleaned.trim());
}

function normTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/#\w+/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Dice coefficient over content words, 0..1. The Dropbox filename and the
// YouTube title are two different humans' names for the same clip ("09 - Youre
// Either Using Eco or your Cheating" vs "You're Either Using Eco or You're
// Cheating"), so we want tolerant word overlap rather than edit distance.
//
// Dice (2*shared / total) and not shared/min(A,B): the min denominator scores a
// two-word filename 1.0 against any long title containing both words, which had
// "Chain Abstraction" matching an ERC-8004 explainer at 0.5 and every short
// filename matching something. Dice is symmetric and penalises the length gap.
export function titleSimilarity(a: string, b: string): number {
  const A = new Set(normTitle(a).split(" ").filter((w) => w.length > 2));
  const B = new Set(normTitle(b).split(" ").filter((w) => w.length > 2));
  if (A.size < MIN_TITLE_TOKENS || B.size < MIN_TITLE_TOKENS) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return (2 * shared) / (A.size + B.size);
}

// Below this a filename has too little signal to match on at all.
const MIN_TITLE_TOKENS = 3;

export const DROPBOX_MATCH_THRESHOLD = 0.5;

// Ingest a Dropbox folder listing. Each entry either enriches an existing
// YouTube row (adding the file and any transcript) or becomes a new
// Dropbox-only row for a clip that never made it to the channel.
//
// NOTE: the deployed app cannot call the Dropbox MCP server, so this takes a
// manifest rather than fetching. scripts/ingest-dropbox-manifest.ts feeds it a
// JSON file produced from the MCP listing. If Dropbox app credentials are added
// later, a real sync function can feed this same ingest unchanged.
export async function ingestDropboxManifest(
  entries: DropboxVideoEntry[],
): Promise<DropboxIngestResult> {
  const res: DropboxIngestResult = {
    entries: entries.length,
    mergedIntoYouTube: 0,
    insertedNew: 0,
    markedDoNotUse: 0,
    transcripts: 0,
  };

  for (const e of entries) {
    const clean = cleanVideoFilename(e.name);
    // The team files rejected cuts under a "Weak (Don't Use)" folder. That is a
    // human quality judgment we already own — carry it, never override it.
    const doNotUse = /weak\s*\(?\s*don'?t use/i.test(e.path);
    const folder = e.path.split("/").slice(-2, -1)[0] ?? null;

    // Step 1: has this exact file been ingested before? If so it OWNS its row,
    // and we update in place. Re-deciding the merge every run is what made this
    // non-idempotent: a file that inserted standalone on run 1 would try to
    // merge into a YouTube row on run 2 and collide on the unique file id.
    const owned = await sql<{ id: number }>`
      SELECT id FROM videos WHERE dropbox_file_id = ${e.fileId}`;

    let targetId = owned[0] ? Number(owned[0].id) : null;
    let isNew = false;

    // Step 2: no row owns it yet — try to merge into a YouTube clip of the same
    // title that has no file attached. Excluding rows that already carry a file
    // stops two delivery variants of one clip fighting over the same row.
    if (targetId == null) {
      const candidates = await sql<{ id: number; title: string }>`
        SELECT id, title FROM videos WHERE dropbox_file_id IS NULL`;
      let best: { id: number; score: number } | null = null;
      for (const v of candidates) {
        const score = titleSimilarity(clean, v.title);
        if (score >= DROPBOX_MATCH_THRESHOLD && (!best || score > best.score)) {
          best = { id: Number(v.id), score };
        }
      }
      if (best) {
        targetId = best.id;
        res.mergedIntoYouTube++;
      }
    }

    // Step 3: still nothing — this clip exists only in Dropbox.
    if (targetId == null) {
      const ins = await sql<{ id: number }>`
        INSERT INTO videos (
          dropbox_file_id, dropbox_path, dropbox_folder, dropbox_bytes,
          title, transcript, transcript_source, do_not_use, active
        ) VALUES (
          ${e.fileId}, ${e.path}, ${folder}, ${e.bytes},
          ${clean || e.name}, ${e.transcript ?? null}::text,
          ${e.transcript ? "dropbox_txt" : null}::text, ${doNotUse}, true
        )
        RETURNING id`;
      targetId = Number(ins[0].id);
      isNew = true;
      res.insertedNew++;
    }

    if (!isNew) {
      // The ::text casts are load-bearing: a bare NULL bind has no inferable
      // type inside COALESCE/CASE and Postgres rejects the statement with
      // "could not determine data type of parameter".
      await sql`
        UPDATE videos SET
          dropbox_file_id = ${e.fileId},
          dropbox_path = ${e.path},
          dropbox_folder = ${folder},
          dropbox_bytes = ${e.bytes},
          do_not_use = ${doNotUse} OR do_not_use,
          transcript = COALESCE(${e.transcript ?? null}::text, transcript),
          transcript_source = CASE
            WHEN ${e.transcript ?? null}::text IS NOT NULL THEN 'dropbox_txt'
            ELSE transcript_source END,
          updated_at = now()
        WHERE id = ${targetId}`;
    }

    if (doNotUse) res.markedDoNotUse++;
    if (e.transcript) res.transcripts++;
  }

  return res;
}

// ---------------------------------------------------------------------------
// The shelf read
// ---------------------------------------------------------------------------

interface VideoShelfSqlRow extends VideoRow {
  useCount: number;
  lastUsed: string | null;
  daysSinceLastUse: number | null;
  medianImpr: number | null;
  bestImpr: number | null;
}

export async function getVideoShelf(): Promise<VideoShelfRow[]> {
  const rows = await sql<VideoShelfSqlRow>`
    WITH used AS (
      SELECT p.video_id, p.id, p.created_at, s.impressions
      FROM posts p
      LEFT JOIN LATERAL (
        SELECT impressions FROM metric_snapshots m
        WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
      ) s ON true
      WHERE p.template = 'short_form_video_eco' AND p.is_reply = false
    )
    SELECT
      v.id,
      v.yt_video_id       AS "ytVideoId",
      v.yt_url            AS "ytUrl",
      to_char(v.yt_published_on, 'YYYY-MM-DD') AS "ytPublishedOn",
      v.yt_views          AS "ytViews",
      v.yt_thumb_url      AS "ytThumbUrl",
      v.dropbox_file_id   AS "dropboxFileId",
      v.dropbox_path      AS "dropboxPath",
      v.dropbox_folder    AS "dropboxFolder",
      v.title, v.description, v.transcript,
      v.duration_sec      AS "durationSec",
      v.series, v.speaker, v.icp, v.topic, v.hook,
      v.do_not_use        AS "doNotUse",
      COUNT(u.id)::int    AS "useCount",
      MAX(u.created_at)   AS "lastUsed",
      EXTRACT(DAY FROM now() - MAX(u.created_at))::int AS "daysSinceLastUse",
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY u.impressions))::int AS "medianImpr",
      MAX(u.impressions)::int AS "bestImpr"
    FROM videos v
    LEFT JOIN used u ON u.video_id = v.id
    WHERE v.active = true
    GROUP BY v.id`;

  const useRows = await sql<VideoUse & { videoId: number | null }>`
    SELECT p.video_id AS "videoId", p.id, p.url, p.created_at AS "createdAt",
           EXTRACT(DAY FROM now() - p.created_at)::int AS "daysAgo",
           p.text, s.impressions
    FROM posts p
    LEFT JOIN LATERAL (
      SELECT impressions FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
    ) s ON true
    WHERE p.template = 'short_form_video_eco' AND p.is_reply = false AND p.video_id IS NOT NULL
    ORDER BY s.impressions DESC NULLS LAST`;

  const usesByVideo = new Map<number, VideoUse[]>();
  for (const u of useRows) {
    const key = Number(u.videoId);
    const list = usesByVideo.get(key) ?? [];
    const { videoId: _drop, ...use } = u;
    list.push(use);
    usesByVideo.set(key, list);
  }

  const maxViews = Math.max(1, ...rows.map((r) => r.ytViews ?? 0));

  return rows
    .map((r) => {
      const id = Number(r.id);
      return {
        ...r,
        id,
        icpLabel: r.icp ? (ICP_BY_ID[r.icp]?.label ?? r.icp) : null,
        seriesLabel: seriesLabel(r.series),
        speakerLabel: speakerLabel(r.speaker),
        hasFile: !!r.dropboxFileId,
        score: videoScore(r, maxViews),
        posts: usesByVideo.get(id) ?? [],
      };
    })
    .sort((a, b) => b.score - a.score);
}

// "Worth posting to X right now", 0..100.
//
// The dominant term is simply: has this clip ever run on X? Roughly 220 of 280
// never have, and a finished clip nobody has seen is worth more than a
// re-run of one they have. YouTube views are a weak quality signal — the median
// short has 46 views, so the channel is not a popularity oracle — and are
// deliberately capped at a small share of the total.
function videoScore(r: VideoShelfSqlRow, maxViews: number): number {
  // The team filed this one under "Weak (Don't Use)". That verdict is final.
  if (r.doNotUse) return 0;

  const neverPosted = r.useCount === 0;
  const rest = neverPosted
    ? 1
    : Math.max(0, Math.min(1, ((r.daysSinceLastUse ?? 0) - 30) / 120));

  // Log-scaled: the channel has one 89k outlier against a 46 median, so a linear
  // scale would make every other clip look like a zero.
  const views = r.ytViews ?? 0;
  const quality = Math.min(1, Math.log10(views + 1) / Math.log10(maxViews + 1));

  // A clip with a transcript or a real description can actually be drafted from;
  // one with nothing but a filename cannot. Reward what the drafter can use.
  const substance = r.transcript ? 1 : (r.description?.length ?? 0) > 120 ? 0.8 : 0.35;

  // Having the file on hand means it can go out today rather than being re-cut.
  const ready = r.dropboxFileId ? 1 : 0.85;

  return Math.round(
    Math.max(0, Math.min(100, (rest * 0.5 + quality * 0.2 + substance * 0.3) * ready * 100)),
  );
}

export async function getVideo(id: number): Promise<VideoRow | null> {
  const rows = await sql<VideoRow>`
    SELECT id, yt_video_id AS "ytVideoId", yt_url AS "ytUrl",
           to_char(yt_published_on,'YYYY-MM-DD') AS "ytPublishedOn",
           yt_views AS "ytViews", yt_thumb_url AS "ytThumbUrl",
           dropbox_file_id AS "dropboxFileId", dropbox_path AS "dropboxPath",
           dropbox_folder AS "dropboxFolder",
           title, description, transcript, duration_sec AS "durationSec",
           series, speaker, icp, topic, hook, do_not_use AS "doNotUse"
    FROM videos WHERE id = ${id}`;
  return rows[0] ?? null;
}
