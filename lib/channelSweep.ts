import Anthropic from "@anthropic-ai/sdk";
import { sql } from "./db.ts";
import { ANALOG_BY_ID } from "./analogs.ts";
import { parseIso8601Duration } from "./quoteLanes.ts";
import {
  CHANNEL_DEFS,
  CHANNEL_BY_ID,
  SHORT_MAX_SEC,
  type ChannelDef,
  type Chapter,
  type ChannelVideoRow,
  type TriageWindow,
  type TriageVerdict,
  chapterWindow,
  descKey,
  parseChapters,
  recordChannelSweep,
  seenVideoIds,
  storeTriage,
  triageIndex,
  untriagedVideos,
  upsertVideo,
} from "./channels.ts";

// The channel lane, phase 1: enumerate and triage. Nothing here writes to
// analog_sources — that is phase 2 — so the whole module is cheap enough to run
// repeatedly while the triage prompt is being tuned.
//
// THE COST LADDER, cheapest rung first. Only the last one is expensive, and the
// point of the first three is to reach it rarely:
//
//   0. list      2 YouTube quota units per channel, against 10,000/day
//   1. triage    one batched Claude call over title + description + chapters
//   2. describe  a 'current' source row with facts_source='description', free   (phase 2)
//   3. transcribe Gemini over the flagged chapter windows only                  (phase 3)
//
// WHY THE UPLOADS PLAYLIST AND NOT listChannelUploads().
// That helper (lib/quoteLanes.ts) uses search.list, which is 100 quota units a
// call. channels.list + playlistItems.list + videos.list is 3 units and returns
// the same thing, complete and in publish order. At three channels a day the
// difference is 9 units against 300. The quote lane still has its own reasons to
// use search (it lists per-roster-person channels it has never seen), so this is
// an addition rather than a replacement.

const YT = "https://www.googleapis.com/youtube/v3";
const MODEL =
  process.env.CHANNEL_TRIAGE_MODEL ||
  process.env.SWEEP_MODEL ||
  "claude-sonnet-4-6";

// YouTube Data API quota units, so spend stays visible the way Firecrawl credits
// do in lib/analogSweep.ts.
const COST_CHANNELS_LIST = 1;
const COST_PLAYLIST_ITEMS = 1;
const COST_VIDEOS_LIST = 1;

export interface ChannelSweepOptions {
  /** Stop starting new work past this timestamp. */
  deadline?: number;
  /** Only consider uploads published in this window. */
  lookbackDays?: number;
  /** Videos to list per channel. */
  maxPerChannel?: number;
  /** Triage at most this many videos this run. */
  maxTriage?: number;
  /** Compute everything, write nothing. The default for a first look. */
  dryRun?: boolean;
  /** Re-triage videos that already carry a verdict. */
  force?: boolean;
}

function ytKey(): string {
  const k = process.env.YOUTUBE_API_KEY;
  if (!k) throw new Error("YOUTUBE_API_KEY is not set");
  return k;
}

// The API returns HTML-encoded titles ("What&#39;s Next"). Same problem the
// quote lane hit; decodeHtml there is module-private, so this is a local twin
// rather than an export widened for one caller.
function decodeHtml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// ---------------------------------------------------------------------------
// Enumerate
// ---------------------------------------------------------------------------

interface ListedVideo {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string | null;
  durationSec: number | null;
}

const uploadsCache = new Map<string, string>();

async function uploadsPlaylistId(
  channelId: string,
): Promise<{ playlistId: string; units: number }> {
  const cached = uploadsCache.get(channelId);
  if (cached) return { playlistId: cached, units: 0 };
  const res = await fetch(
    `${YT}/channels?${new URLSearchParams({ key: ytKey(), part: "contentDetails", id: channelId })}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok)
    throw new Error(
      `YouTube channels ${res.status}: ${(await res.text()).slice(0, 160)}`,
    );
  const data = await res.json();
  const pl = data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  // The uploads playlist is conventionally the channel id with UC->UU, but the
  // convention is not a contract, so it is read rather than derived.
  if (!pl) throw new Error(`no uploads playlist for channel ${channelId}`);
  uploadsCache.set(channelId, pl);
  return { playlistId: pl, units: COST_CHANNELS_LIST };
}

async function listUploads(
  channelId: string,
  sinceIso: string,
  max: number,
): Promise<{ videos: ListedVideo[]; units: number }> {
  const { playlistId, units: chUnits } = await uploadsPlaylistId(channelId);
  let units = chUnits;

  const pres = await fetch(
    `${YT}/playlistItems?${new URLSearchParams({
      key: ytKey(),
      part: "contentDetails",
      playlistId,
      maxResults: String(Math.min(50, max)),
    })}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!pres.ok)
    throw new Error(
      `YouTube playlistItems ${pres.status}: ${(await pres.text()).slice(0, 160)}`,
    );
  units += COST_PLAYLIST_ITEMS;
  const pdata = await pres.json();

  // The playlist is newest-first, so the lookback filter can be applied here,
  // before paying for the detail call.
  const ids: string[] = (pdata.items ?? [])
    .filter((i: { contentDetails?: { videoPublishedAt?: string } }) => {
      const at = i.contentDetails?.videoPublishedAt;
      return !at || at >= sinceIso;
    })
    .map(
      (i: { contentDetails?: { videoId?: string } }) =>
        i.contentDetails?.videoId,
    )
    .filter(Boolean);
  if (!ids.length) return { videos: [], units };

  // One batched detail call. contentDetails carries the duration (which decides
  // short vs episode) and snippet carries the full untruncated description,
  // where the chapters and the checkable claims live.
  const vres = await fetch(
    `${YT}/videos?${new URLSearchParams({
      key: ytKey(),
      part: "snippet,contentDetails",
      id: ids.slice(0, 50).join(","),
    })}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!vres.ok)
    throw new Error(
      `YouTube videos ${vres.status}: ${(await vres.text()).slice(0, 160)}`,
    );
  units += COST_VIDEOS_LIST;
  const vdata = await vres.json();

  const videos: ListedVideo[] = (vdata.items ?? []).map(
    (v: {
      id: string;
      snippet: { title: string; description?: string; publishedAt?: string };
      contentDetails?: { duration?: string };
    }) => ({
      videoId: v.id,
      title: decodeHtml(v.snippet.title ?? ""),
      description: v.snippet.description ?? "",
      publishedAt: v.snippet.publishedAt ?? null,
      durationSec: parseIso8601Duration(v.contentDetails?.duration),
    }),
  );
  return { videos, units };
}

/**
 * Link every clip to the episode it was cut from, in one statement.
 *
 * Exact, not fuzzy: a clip carries its parent's whole description byte for byte.
 * Runs after the upsert because a clip can be listed before its parent (Money
 * Code published five clips on 27 Jul from a 23 Jul episode), so the link has to
 * be resolvable on a later run than the one that first saw the clip.
 */
async function linkParents(channelId: string): Promise<number> {
  const rows = await sql<{ n: string }>`
    WITH parents AS (
      SELECT DISTINCT ON (desc_key) desc_key, video_id
      FROM channel_videos
      WHERE channel_id = ${channelId} AND desc_key IS NOT NULL AND is_short = false
      ORDER BY desc_key, duration_sec DESC NULLS LAST
    ), linked AS (
      UPDATE channel_videos c
      SET parent_video_id = p.video_id, updated_at = now()
      FROM parents p
      WHERE c.channel_id = ${channelId} AND c.is_short = true
        AND c.desc_key = p.desc_key
        AND c.parent_video_id IS DISTINCT FROM p.video_id
      RETURNING 1
    )
    SELECT count(*)::text AS n FROM linked
  `;
  return Number(rows[0]?.n ?? 0);
}

export interface EnumerateResult {
  channelId: string;
  label: string;
  /** Videos the API returned inside the lookback window. */
  listed: number;
  /**
   * Videos dropped before the ledger, because the channel's clips are not
   * curriculum material (takeShorts = false). Reported separately because
   * without it `listed` and `fresh` count different populations: Philip
   * Meissner's first report read "12 listed · 3 new" on an empty ledger, which
   * looks like nine already-seen videos and is really nine excluded clips.
   */
  excluded: number;
  fresh: number;
  linked: number;
  quotaUnits: number;
  warnings: string[];
}

export async function enumerateChannel(
  def: ChannelDef,
  opts: ChannelSweepOptions = {},
): Promise<EnumerateResult> {
  const lookbackDays = opts.lookbackDays ?? 45;
  const sinceIso = new Date(
    Date.now() - lookbackDays * 86_400_000,
  ).toISOString();
  const warnings: string[] = [];

  const { videos, units } = await listUploads(
    def.id,
    sinceIso,
    opts.maxPerChannel ?? 25,
  );
  // A dry run must work against a database that has never had Migration 012
  // applied — that is the state it exists for. Only the "new since last run"
  // count depends on the ledger, so losing it degrades one number rather than
  // the whole report.
  let seen: Set<string>;
  try {
    seen = await seenVideoIds(def.id);
  } catch (err) {
    if (!opts.dryRun) throw err;
    warnings.push(
      `ledger unreadable (${String(err).slice(0, 60)}) — "new" counts every listed video`,
    );
    seen = new Set<string>();
  }
  let fresh = 0;
  let excluded = 0;

  for (const v of videos) {
    const isShort = v.durationSec != null && v.durationSec <= SHORT_MAX_SEC;
    if (isShort && !def.takeShorts) {
      excluded++;
      continue;
    }
    if (!seen.has(v.videoId)) fresh++;
    if (opts.dryRun) continue;
    await upsertVideo({
      videoId: v.videoId,
      channelId: def.id,
      title: v.title,
      description: v.description || null,
      publishedAt: v.publishedAt,
      durationSec: v.durationSec,
      isShort,
      descKey: descKey(v.description),
      parentVideoId: null,
      // A clip inherits its parent's chapter block verbatim, and those
      // timestamps describe a DIFFERENT video. Storing them would send a
      // transcription window into the wrong minutes of the wrong file, so a
      // short's chapter list is empty by construction.
      chapters: isShort ? [] : parseChapters(v.description),
    });
  }

  const linked = opts.dryRun ? 0 : await linkParents(def.id);
  return {
    channelId: def.id,
    label: def.label,
    listed: videos.length,
    excluded,
    fresh,
    linked,
    quotaUnits: units,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Triage
//
// One model call decides, for each new video, whether it touches a curriculum
// concept and which minutes matter. This is the rung that makes the lane
// affordable: Philip Meissner publishes an aphorism clip most weeks and a
// stablecoin episode about once a month, and rejecting the former has to cost
// approximately nothing.
//
// WHY A MODEL AND NOT THE VOCAB MATCHER. Measured over 36 recent videos on these
// three channels, detectAnalog() matched 3 on titles. The vocabulary is tradfi
// ("nostro", "prefunding", "trapped liquidity") and these channels speak
// stablecoin-native, so "The Funding Bottleneck Slowing Stablecoin Payments" — a
// textbook nostro_vostro episode — matched nothing at all. Adding descriptions
// raised it to 14/36 but introduced a worse failure: a clip inherits its
// parent's description, so a 44-second video matched a concept off a blurb about
// a different recording. A mis-filed source is worse than a missing one on this
// shelf, whose entire value is an honest coverage board.
//
// The matcher is still run, but only as a REPORTED cross-check in the dry run.
// It never gates and it is never shown to the model, which would anchor a
// 3-of-36 signal into a decision that outperforms it.
// ---------------------------------------------------------------------------

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY)
      throw new Error("ANTHROPIC_API_KEY is not set");
    _client = new Anthropic();
  }
  return _client;
}

// Descriptions run to 3,300 characters and the tail is sponsor boilerplate
// ("About BVNK ..."). Chapters are sent separately as a parsed list, so their
// lines are stripped here rather than paid for twice.
function descForPrompt(
  description: string | null,
  chapters: Chapter[],
): string {
  if (!description) return "";
  let text = description;
  if (chapters.length) {
    text = text
      .split(/\r?\n/)
      .filter(
        (line) =>
          !/^[\s\-–—•*]*\(?\d{1,2}:\d{2}(?::\d{2})?\)?[\s\-–—:|]/.test(line),
      )
      .join("\n");
  }
  return text
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 1800);
}

/**
 * Videos sharing a description are one prompt item.
 *
 * Six Money Code clips and their parent episode carry the same 2,822-character
 * description. Sent per video that is ~17k characters of duplication; sent as a
 * group it is 2.8k plus six one-line titles. The titles still go individually,
 * because on these channels the clip TITLE is the claim and is the only thing
 * distinguishing one clip from another.
 */
interface TriageGroup {
  def: ChannelDef;
  descKey: string | null;
  description: string;
  chapters: Chapter[];
  videos: ChannelVideoRow[];
}

function groupForTriage(rows: ChannelVideoRow[]): TriageGroup[] {
  const groups = new Map<string, TriageGroup>();
  for (const r of rows) {
    const def = CHANNEL_BY_ID[r.channelId];
    if (!def) continue;
    // A null desc_key means the description was too short to be a reliable
    // grouping key, so those videos each stand alone.
    const key = r.descKey
      ? `${r.channelId}:${r.descKey}`
      : `${r.channelId}:solo:${r.videoId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.videos.push(r);
      // Chapters live on the episode, not the clip. Whichever member has them
      // speaks for the group.
      if (!existing.chapters.length && r.chapters.length) {
        existing.chapters = r.chapters;
        existing.description = r.description ?? existing.description;
      }
      continue;
    }
    groups.set(key, {
      def,
      descKey: r.descKey,
      description: r.description ?? "",
      chapters: r.chapters,
      videos: [r],
    });
  }
  return [...groups.values()];
}

function fmtDur(sec: number | null): string {
  if (sec == null) return "?";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  return sec % 60 ? `${m}m${sec % 60}s` : `${m}m`;
}

function fmtTs(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function buildTriagePrompt(groups: TriageGroup[]): string {
  const blocks = groups
    .map((g, i) => {
      const chapters = g.chapters.length
        ? g.chapters
            .map((c) => `    ${c.startSec} (${fmtTs(c.startSec)}) ${c.title}`)
            .join("\n")
        : "    (none published)";
      const videos = g.videos
        .map(
          (v) =>
            `    ${v.videoId} | ${v.isShort ? "CLIP" : "EPISODE"} | ${fmtDur(v.durationSec)} | ` +
            `${(v.publishedAt ?? "").slice(0, 10)} | "${v.title}"`,
        )
        .join("\n");
      return `=== GROUP ${i + 1} ===
CHANNEL: ${g.def.label} (${g.def.handle})${g.def.interestedParty ? " — COMMERCIALLY INTERESTED PARTY" : ""}
ABOUT THIS CHANNEL: ${g.def.note}

SHARED DESCRIPTION (one recording; the clips below were cut from it):
"""
${descForPrompt(g.description, g.chapters)}
"""

CHAPTER STARTS (seconds, then the publisher's own label):
${chapters}

VIDEOS TO DECIDE (id | kind | length | published | title):
${videos}`;
    })
    .join("\n\n");

  return `You are filing podcast videos against a fixed curriculum of traditional-finance mechanisms, for a team that writes educational posts explaining those mechanisms. Your job is routing, not writing.

THE CURRICULUM. These are the only concepts that exist. Never invent an id.

${triageIndex()}

DECIDE, FOR EACH VIDEO ID:

verdict:
  "relevant"  — it explains, evidences, or reports something specific about one or
                more of the mechanisms above. The video will almost never use the
                tradfi term: a guest describing "we had to prefund accounts in
                every corridor and it killed our working capital" IS nostro_vostro,
                and an episode on why a payout fails and gets retried IS
                cascading_retries. Route on the MECHANISM, not the vocabulary.
  "off_topic" — no mechanism above is discussed in any substantive way. General
                crypto commentary, funding news, company profiles, career or
                leadership talk, geopolitics, AI. Be decisive here; a cheap
                rejection is the most valuable thing you can return.
  "unclear"   — the metadata genuinely does not say. Use this sparingly.

analogIds: every concept the video substantively covers, most central first, at
  most three. Required when the verdict is relevant. A long episode legitimately
  touches several; a 45-second clip almost always covers exactly one.

confidence: 0-100, how sure you are of the verdict AND the ids, judged only on
  the metadata you were given.

note: one short clause saying why. This is read by an operator deciding whether
  to spend money transcribing.

windows: which chapters are worth transcribing, at most 3, EPISODES ONLY.
  Give startSec copied exactly from a CHAPTER STARTS line above, plus the
  analogId that chapter serves. Return [] for a CLIP (the whole clip is the
  window) and [] when no chapters were published. Pick the chapters where the
  mechanism is actually discussed, not the intro or the sponsor read.

  A window is a decision to spend money transcribing those minutes, so return
  one ONLY when the chapter's own label makes the mechanism plain. If your
  reason would contain "likely", "probably", "may cover" or "presumably", leave
  the window out. Two certain windows beat four hopeful ones, and returning
  none while the verdict stays relevant is a perfectly good answer — the
  description-tier facts are still worth having.

descFacts: checkable claims ALREADY PRESENT in the description text above —
  specific numbers, named systems, corridors, dates, volumes. Copy them close to
  verbatim. Return [] if the description has none. Never infer a number, never
  carry one over from your own knowledge, and never take a claim from the title.

TWO THINGS TO BE CAREFUL ABOUT:

1. The description belongs to the EPISODE. A clip cut from it may be about only
   one narrow moment, so judge a CLIP primarily on its own title and use the
   description only as context. Do not assume a clip covers everything the
   episode covers.

2. These publishers are often commercially interested in what they are
   explaining. That does not make a video irrelevant — it is exactly the current,
   operator-level evidence we want — but a guest's claim about their own product
   is a claim, not a measurement. Still file it; the tier and the wording are
   handled downstream.

Return ONLY a JSON object, no prose, no code fences. One entry per video id given:
{"videos":[{"videoId":"...","verdict":"relevant","confidence":80,"note":"...","analogIds":["nostro_vostro"],"windows":[{"startSec":108,"analogId":"nostro_vostro","why":"..."}],"descFacts":["..."]}]}

${blocks}`;
}

interface RawTriage {
  videoId?: unknown;
  verdict?: unknown;
  confidence?: unknown;
  note?: unknown;
  analogIds?: unknown;
  windows?: unknown;
  descFacts?: unknown;
}

/**
 * Parse and, more importantly, CONSTRAIN the model's output.
 *
 * Three things are enforced here rather than asked for in the prompt, because
 * each one silently corrupts the shelf if it slips through:
 *
 *   * concept ids must exist in ANALOG_DEFS. An invented id would create a
 *     phantom row on a coverage board whose whole job is honesty.
 *   * a window's start must be a real published chapter start, and its END is
 *     computed here from the next chapter. The model chooses WHICH chapter; it
 *     does not get to choose the bounds, because a hallucinated end offset is a
 *     Gemini bill in phase 3.
 *   * "relevant" with no surviving concept id is downgraded to "unclear". A
 *     relevant verdict that names nothing cannot be acted on, and letting it
 *     stand as relevant would put an unroutable video in the transcribe queue.
 */
function parseTriage(text: string, groups: TriageGroup[]): TriageVerdict[] {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const a = t.indexOf("{");
  const z = t.lastIndexOf("}");
  if (a === -1 || z === -1) return [];

  let list: RawTriage[];
  try {
    const obj = JSON.parse(t.slice(a, z + 1));
    list = Array.isArray(obj?.videos) ? obj.videos : [];
  } catch {
    return [];
  }

  const byId = new Map<string, { row: ChannelVideoRow; group: TriageGroup }>();
  for (const g of groups)
    for (const v of g.videos) byId.set(v.videoId, { row: v, group: g });

  const out: TriageVerdict[] = [];
  for (const r of list) {
    const videoId = String(r.videoId ?? "");
    const ctx = byId.get(videoId);
    if (!ctx) continue;

    const analogIds = (Array.isArray(r.analogIds) ? r.analogIds : [])
      .map((x) => String(x).trim())
      .filter((id) => !!ANALOG_BY_ID[id])
      .slice(0, 3);

    let verdict: TriageVerdict["verdict"] =
      r.verdict === "relevant"
        ? "relevant"
        : r.verdict === "off_topic"
          ? "off_topic"
          : "unclear";
    if (verdict === "relevant" && !analogIds.length) verdict = "unclear";

    // Windows are episode-only and must land on a published chapter. A clip is
    // its own window, so it carries none.
    const chapters = ctx.row.isShort ? [] : ctx.row.chapters;
    const starts = new Map(chapters.map((c, i) => [c.startSec, i]));
    const windows: TriageWindow[] = (Array.isArray(r.windows) ? r.windows : [])
      .map((w) => {
        const o = (w ?? {}) as Record<string, unknown>;
        const startSec = Number(o.startSec);
        const idx = starts.get(startSec);
        if (idx == null) return null;
        const analogId = String(o.analogId ?? analogIds[0] ?? "");
        if (!ANALOG_BY_ID[analogId]) return null;
        const { endSec } = chapterWindow(chapters, idx, ctx.row.durationSec);
        return {
          startSec,
          endSec,
          analogId,
          why: String(o.why ?? "").slice(0, 200),
        };
      })
      .filter((w): w is TriageWindow => w != null)
      .slice(0, 3);

    const confidence = Math.max(
      0,
      Math.min(100, Math.round(Number(r.confidence) || 0)),
    );
    const descFacts = (Array.isArray(r.descFacts) ? r.descFacts : [])
      .map((f) => String(f).trim())
      .filter(Boolean)
      .slice(0, 8);

    out.push({
      videoId,
      verdict,
      confidence,
      note: String(r.note ?? "").trim(),
      analogIds,
      windows,
      descFacts,
    });
  }
  return out;
}

// Batching is by VIDEO count, not group count, and the first run showed why:
// five groups per call sounded conservative until one Money Code group carried
// six clips and a Tokenized group carried one. A relevant video costs roughly
// 250 output tokens (three windows with reasons, plus description facts), so a
// batch that happens to hold 20 of them runs past max_tokens, the JSON is cut
// mid-object, and parseTriage loses the ENTIRE batch rather than one entry.
// That is exactly what happened: 22 of 40 videos came back with no verdict.
//
// Groups are never split across calls — the whole point of a group is that its
// shared description is sent once.
const VIDEOS_PER_CALL = 8;
const MAX_TOKENS = 16_000;

function batchGroups(groups: TriageGroup[]): TriageGroup[][] {
  const batches: TriageGroup[][] = [];
  let current: TriageGroup[] = [];
  let count = 0;
  for (const g of groups) {
    if (current.length && count + g.videos.length > VIDEOS_PER_CALL) {
      batches.push(current);
      current = [];
      count = 0;
    }
    current.push(g);
    count += g.videos.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

export interface TriageResult {
  verdicts: TriageVerdict[];
  /** Videos sent but not returned by the model. */
  missing: string[];
  calls: number;
  inputTokens: number;
  outputTokens: number;
  warnings: string[];
}

export async function triageVideos(
  rows: ChannelVideoRow[],
  opts: ChannelSweepOptions = {},
): Promise<TriageResult> {
  const warnings: string[] = [];
  const verdicts: TriageVerdict[] = [];
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  const batches = batchGroups(groupForTriage(rows));
  for (const [n, batch] of batches.entries()) {
    if (opts.deadline != null && Date.now() > opts.deadline) {
      const left = batches
        .slice(n)
        .reduce(
          (sum, b) => sum + b.reduce((s, g) => s + g.videos.length, 0),
          0,
        );
      warnings.push(
        `Out of time with ${left} video(s) untriaged; they stay in the queue for the next run.`,
      );
      break;
    }
    try {
      const msg = await client().messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: buildTriagePrompt(batch) }],
      });
      calls++;
      inputTokens += msg.usage?.input_tokens ?? 0;
      outputTokens += msg.usage?.output_tokens ?? 0;
      // A truncated response is the failure mode that loses a whole batch
      // silently, so it is named rather than inferred from a missing verdict.
      if (msg.stop_reason === "max_tokens") {
        warnings.push(
          `batch ${n + 1} hit max_tokens (${msg.usage?.output_tokens} out) — its JSON is cut off. ` +
            `Lower VIDEOS_PER_CALL.`,
        );
      }
      const block = msg.content.find((b) => b.type === "text");
      const parsed = parseTriage(
        block && block.type === "text" ? block.text : "",
        batch,
      );
      verdicts.push(...parsed);
      const returned = new Set(parsed.map((p) => p.videoId));
      for (const g of batch) {
        for (const v of g.videos) {
          if (!returned.has(v.videoId)) {
            warnings.push(
              `no verdict returned for ${v.videoId} ("${v.title.slice(0, 50)}")`,
            );
          }
        }
      }
    } catch (err) {
      warnings.push(
        `triage batch ${n + 1} failed: ${String(err).slice(0, 160)}`,
      );
    }
  }

  const sent = new Set(rows.map((r) => r.videoId));
  const got = new Set(verdicts.map((v) => v.videoId));
  return {
    verdicts,
    missing: [...sent].filter((id) => !got.has(id)),
    calls,
    inputTokens,
    outputTokens,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface ChannelSweepResult {
  enumerated: EnumerateResult[];
  triage: TriageResult;
  /** The rows triage actually saw, so a caller can print a joined report. */
  queue: ChannelVideoRow[];
  stored: number;
  dryRun: boolean;
  warnings: string[];
}

export async function runChannelSweep(
  opts: ChannelSweepOptions = {},
): Promise<ChannelSweepResult> {
  const warnings: string[] = [];
  const enumerated: EnumerateResult[] = [];

  for (const def of CHANNEL_DEFS) {
    if (opts.deadline != null && Date.now() > opts.deadline) {
      warnings.push(`Out of time before listing ${def.label}.`);
      break;
    }
    try {
      const r = await enumerateChannel(def, opts);
      enumerated.push(r);
      warnings.push(...r.warnings);
    } catch (err) {
      const msg = String(err).slice(0, 200);
      warnings.push(`${def.label}: ${msg}`);
      if (!opts.dryRun) {
        await recordChannelSweep({
          channelId: def.id,
          status: "failed",
          listed: 0,
          fresh: 0,
          relevant: 0,
          quotaUnits: 0,
          error: msg,
        });
      }
    }
  }

  // In a dry run nothing was written, so the queue is rebuilt from the API
  // response instead of the ledger. That keeps --dry-run honest on a virgin
  // database: it reports exactly what a real run would triage.
  const queue = opts.dryRun
    ? await dryRunQueue(opts)
    : await untriagedVideos(opts.maxTriage ?? 40);

  const triage = queue.length ? await triageVideos(queue, opts) : emptyTriage();
  warnings.push(...triage.warnings);

  let stored = 0;
  if (!opts.dryRun) {
    for (const v of triage.verdicts) {
      await storeTriage(v);
      stored++;
    }
    const byChannel = new Map(queue.map((q) => [q.videoId, q.channelId]));
    const missing = new Set(triage.missing);
    for (const e of enumerated) {
      const mine = triage.verdicts.filter(
        (v) => byChannel.get(v.videoId) === e.channelId,
      );
      // Status is per channel, not per run. A missing verdict on one Money Code
      // clip must not mark Tokenized partial: the whole reason this table exists
      // is so a glance says which channel is actually behind.
      const mineMissing = queue.filter(
        (q) => q.channelId === e.channelId && missing.has(q.videoId),
      );
      await recordChannelSweep({
        channelId: e.channelId,
        status: mineMissing.length ? "partial" : "ok",
        listed: e.listed,
        fresh: e.fresh,
        relevant: mine.filter((v) => v.verdict === "relevant").length,
        quotaUnits: e.quotaUnits,
        error: mineMissing.length
          ? `${mineMissing.length} video(s) got no verdict`
          : null,
      });
    }
  }

  return { enumerated, triage, queue, stored, dryRun: !!opts.dryRun, warnings };
}

function emptyTriage(): TriageResult {
  return {
    verdicts: [],
    missing: [],
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    warnings: [],
  };
}

/**
 * Rebuild the would-be queue straight from the API for a dry run.
 *
 * Re-lists rather than reusing enumerateChannel's return value, which is
 * deliberately a count summary. The extra cost is 3 quota units a channel and
 * the alternative is a second shape of the same data threaded through the
 * enumerate path only for dry runs.
 */
async function dryRunQueue(
  opts: ChannelSweepOptions,
): Promise<ChannelVideoRow[]> {
  const lookbackDays = opts.lookbackDays ?? 45;
  const sinceIso = new Date(
    Date.now() - lookbackDays * 86_400_000,
  ).toISOString();
  const rows: ChannelVideoRow[] = [];

  for (const def of CHANNEL_DEFS) {
    let videos: ListedVideo[];
    try {
      videos = (await listUploads(def.id, sinceIso, opts.maxPerChannel ?? 25))
        .videos;
    } catch {
      continue;
    }
    const seen = opts.force
      ? new Set<string>()
      : await seenVideoIds(def.id).catch(() => new Set<string>());
    for (const v of videos) {
      const isShort = v.durationSec != null && v.durationSec <= SHORT_MAX_SEC;
      if (isShort && !def.takeShorts) continue;
      if (seen.has(v.videoId)) continue;
      rows.push({
        videoId: v.videoId,
        channelId: def.id,
        title: v.title,
        description: v.description || null,
        publishedAt: v.publishedAt,
        durationSec: v.durationSec,
        isShort,
        descKey: descKey(v.description),
        parentVideoId: null,
        chapters: isShort ? [] : parseChapters(v.description),
        triagedAt: null,
        triageVerdict: null,
        triageConfidence: null,
        triageNote: null,
        analogIds: [],
        windows: [],
        descFacts: [],
        sourceState: "pending",
        transcribeState: "pending",
      });
    }
  }
  rows.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  return rows.slice(0, opts.maxTriage ?? 40);
}
