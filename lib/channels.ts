import { sql } from "./db.ts";
import { ANALOG_DEFS } from "./analogs.ts";
import { createHash } from "node:crypto";

// The watched-channel registry for Lane 1 (Broad Educational / analog
// curriculum), and the deterministic metadata work that happens before any
// model or Gemini call.
//
// WHY A REGISTRY IN CODE, like lib/analogs.ts and unlike watch_sources.
// The quote pipeline keeps its channels in watch_sources because that list is
// operator-editable roster data. What this lane needs to know about a channel is
// editorial judgment: is the publisher an interested party (which caps what tier
// its material can reach), are its clips worth taking, how thin is its hit rate.
// Those belong next to the reasoning that produced them, so they live here and
// only the rotation state lives in a table.
//
// The channels are ALSO seeded into watch_sources (lib/quoteRoster.ts WATCH_SEED)
// so the quote lane picks them up. That is not duplication — two consumers, one
// ingest, joined through raw_documents. Nothing here should be the only place a
// channel is named.

export interface ChannelDef {
  /** YouTube channelId. Pinned rather than resolved from the handle at runtime:
   *  a handle can be changed by its owner, and resolveYouTubeChannel() falls
   *  back to a search that has returned the wrong channel before (see the
   *  Money20/20 note in lib/quoteRoster.ts). */
  id: string;
  handle: string;
  label: string;
  /**
   * The publisher has a commercial position in the thing it is explaining.
   * Money Code is "Presented by Stablecon; Powered by BVNK"; Tokenized is
   * co-hosted by Visa's head of crypto. Both are excellent and neither is a
   * mechanism authority, so an interested party can never reach the `canonical`
   * tier in analog_sources. Enforced in code, not asked for in a prompt.
   */
  interestedParty: boolean;
  /**
   * Take this channel's Shorts as targets in their own right.
   *
   * The quote lane filters to durationSec >= 240 ("Shorts are never a panel or
   * an interview") and that is right for its channels. It is wrong for these
   * two: Money Code and Tokenized cut their own clips around the single
   * sharpest claim in an episode and title them AS the claim ("A Tiny Stablecoin
   * Depeg Can Cost Institutions $100,000"). That is a free editorial pick of the
   * best 45 seconds, and it is ~60x cheaper to transcribe than the parent.
   */
  takeShorts: boolean;
  /** What this channel is for, and what it is not. Handed to the triage call. */
  note: string;
}

export const CHANNEL_DEFS: ChannelDef[] = [
  {
    id: "UC03s4ohGxrFSMHxGR8DMzZg",
    handle: "@moneycodepod",
    label: "Money Code",
    interestedParty: true,
    takeShorts: true,
    note:
      "Stablecoin operator interviews, presented by Stablecon and powered by BVNK. " +
      "Densest fit of the three: recent episodes map almost one-for-one onto Tier 2 " +
      "concepts (correspondent banking, prefunding and trapped liquidity, local " +
      "liquidity, SWIFT). Guests are practitioners describing their own operations, " +
      "so numbers are self-reported.",
  },
  {
    id: "UC8SaXHFAqVHUjE2OLUFakjw",
    handle: "@TokenizedPodcast",
    label: "Tokenized",
    interestedParty: true,
    takeShorts: true,
    note:
      "Co-hosted by Cuy Sheffield (head of crypto, Visa) and Simon Taylor (Fintech " +
      "Brainfood), explicitly made for regulators, bankers and payments " +
      "professionals — the commercial door the curriculum is aimed at. Uses recent " +
      "news to frame market structure, which is exactly the 'current' layer the " +
      "institutional lane cannot produce.",
  },
  {
    id: "UCoX2V7454TPPAhWu172lGGQ",
    handle: "@WhatsNextwithPhilipMeissner",
    label: "What's Next with Philip Meissner",
    interestedParty: false,
    takeShorts: false,
    note:
      "Broad technology and innovation podcast, 942k subscribers. Mostly talent, " +
      "geopolitics, leadership and AI, with an occasional stablecoin or payments " +
      "episode. Low hit-rate and high reach: triage should reject most of it, and " +
      "the rejections are the cheapest thing this lane does. Shorts are aphorism " +
      "clips ('Regret Is Worse Than Rejection') and are never curriculum material.",
  },
];

export const CHANNEL_BY_ID: Record<string, ChannelDef> = Object.fromEntries(
  CHANNEL_DEFS.map((c) => [c.id, c]),
);

// A YouTube video at or under three minutes is a Short. Observed on these
// channels: clips run 23s-1m29s and episodes run 26m+, so nothing sits near the
// boundary and the exact threshold is not load-bearing.
export const SHORT_MAX_SEC = 180;

// ---------------------------------------------------------------------------
// Chapters
//
// The single most valuable thing in a podcast description, and free. Every
// long-form episode on these channels ships 10-17 lines of `MM:SS Title`, which
// is a human-written timestamped topic index. It is what lets phase 3 transcribe
// six minutes of a 46-minute episode instead of all of it, and it gives
// youtubeDeepLink() a real moment to land on.
//
// Deliberately deterministic. A model would parse this perfectly and there is no
// reason to pay one for a regex.
// ---------------------------------------------------------------------------

export interface Chapter {
  startSec: number;
  title: string;
}

const CHAPTER_LINE =
  /^[\s\-–—•*]*\(?(\d{1,2}):(\d{2})(?::(\d{2}))?\)?[\s\-–—:|]*(.+?)\s*$/;

export function parseChapters(
  description: string | null | undefined,
): Chapter[] {
  if (!description) return [];
  const out: Chapter[] = [];
  for (const line of description.split(/\r?\n/)) {
    const m = line.match(CHAPTER_LINE);
    if (!m) continue;
    // Two shapes share this pattern: MM:SS and HH:MM:SS. When the third group is
    // present the first is hours.
    const startSec = m[3]
      ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
      : Number(m[1]) * 60 + Number(m[2]);
    const title = m[4].trim();
    // A bare timestamp with no title is a stray reference in prose, not a
    // chapter. So is a "title" that is just a URL.
    if (title.length < 3 || /^https?:\/\//i.test(title)) continue;
    out.push({ startSec, title });
  }
  // A real chapter list starts at or near zero and advances. Anything else is
  // prose that happened to contain timestamps (a guest citing "see 12:30"), and
  // treating it as a chapter index would send a transcription window at random.
  if (out.length < 3) return [];
  const ascending = out.every(
    (c, i) => i === 0 || c.startSec > out[i - 1].startSec,
  );
  if (!ascending || out[0].startSec > 120) return [];
  return out;
}

/**
 * End of a chapter = start of the next one, or the video's end. Chapter lists
 * give starts only, and a transcription window needs both.
 */
export function chapterWindow(
  chapters: Chapter[],
  index: number,
  durationSec: number | null,
): { startSec: number; endSec: number } {
  const startSec = chapters[index].startSec;
  const next = chapters[index + 1]?.startSec;
  return { startSec, endSec: next ?? durationSec ?? startSec + 300 };
}

// ---------------------------------------------------------------------------
// Parent linking
//
// Shorts on these channels inherit their parent episode's ENTIRE description,
// byte-identical: five Money Code clips and the Jack Chong episode they were cut
// from all carry the same 2822 characters. So the parent key is exact and needs
// no similarity scoring. Two things follow:
//
//   * Triaging one description group covers the whole clip family, so the triage
//     call is deduped by this key rather than by video.
//   * A short's `chapters` must be EMPTY even though its description parses
//     fine — those timestamps describe the parent, and using them would send a
//     window into the wrong minutes of a different video.
//
// FOR PHASE 2, from the first dry run: description-derived facts belong to the
// PARENT episode's source row only. "processed more than $3B over the last 12
// months" came back on five Money Code clips and their episode, because all six
// carry the same description — storing it six times would put one claim behind
// six citations and inflate every count on the curriculum shelf. A clip with a
// parent_video_id contributes TRANSCRIPT facts and nothing else.
// ---------------------------------------------------------------------------

export function descKey(description: string | null | undefined): string | null {
  const norm = (description ?? "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  // Below this a description is a stub ("Subscribe!") and would collide across
  // unrelated videos, which is the one thing an exact key must not do.
  if (norm.length < 200) return null;
  return createHash("sha256").update(norm).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// The triage index
//
// Deliberately NOT analogPromptIndex(). That one is id + tier + side + label,
// and its comment says parallel and break are omitted because it is "for
// routing, not for drafting."
//
// Routing a PODCAST is the case where that is not enough, and the number is
// measured: detectAnalog() over 36 recent videos matched 3 on titles. The vocab
// is tradfi language and the podcast speaks stablecoin-native, so the model
// needs the bridge — the parallel is precisely the sentence that says
// "prefunded accounts in every corridor" and "nostro/vostro" are the same
// mechanism. Vocabulary is included for the same reason.
//
// breaksWhere and guardrail are still omitted. Those are drafting inputs, and
// including them here would invite the triage call to start arguing Eco's
// position instead of filing a video.
// ---------------------------------------------------------------------------
export function triageIndex(): string {
  return ANALOG_DEFS.map(
    (a) =>
      `- ${a.id} (tier ${a.tier}, ${a.side}) — ${a.label}\n` +
      `    is: ${a.parallel}\n` +
      `    terms: ${a.vocab.slice(0, 6).join(", ")}`,
  ).join("\n");
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export interface ChannelVideoRow {
  videoId: string;
  channelId: string;
  title: string;
  description: string | null;
  publishedAt: string | null;
  durationSec: number | null;
  isShort: boolean;
  descKey: string | null;
  parentVideoId: string | null;
  chapters: Chapter[];
  triagedAt: string | null;
  triageVerdict: string | null;
  triageConfidence: number | null;
  triageNote: string | null;
  analogIds: string[];
  windows: TriageWindow[];
  descFacts: string[];
  sourceState: string;
  transcribeState: string;
}

export interface TriageWindow {
  startSec: number;
  endSec: number;
  analogId: string;
  why: string;
}

/** Videos we have already seen, so a re-listing costs nothing downstream. */
export async function seenVideoIds(channelId: string): Promise<Set<string>> {
  const rows = await sql<{ videoId: string }>`
    SELECT video_id AS "videoId" FROM channel_videos WHERE channel_id = ${channelId}
  `;
  return new Set(rows.map((r) => r.videoId));
}

export interface UpsertVideo {
  videoId: string;
  channelId: string;
  title: string;
  description: string | null;
  publishedAt: string | null;
  durationSec: number | null;
  isShort: boolean;
  descKey: string | null;
  parentVideoId: string | null;
  chapters: Chapter[];
}

/**
 * Record a listed video. Metadata only — triage columns are untouched, so a
 * re-listing never discards a verdict we already paid for.
 */
export async function upsertVideo(v: UpsertVideo): Promise<void> {
  await sql`
    INSERT INTO channel_videos (video_id, channel_id, title, description, published_at,
                                duration_sec, is_short, desc_key, parent_video_id, chapters)
    VALUES (${v.videoId}, ${v.channelId}, ${v.title}, ${v.description}, ${v.publishedAt},
            ${v.durationSec}, ${v.isShort}, ${v.descKey}, ${v.parentVideoId},
            ${JSON.stringify(v.chapters)}::jsonb)
    ON CONFLICT (video_id) DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      duration_sec = COALESCE(EXCLUDED.duration_sec, channel_videos.duration_sec),
      is_short = EXCLUDED.is_short,
      desc_key = EXCLUDED.desc_key,
      -- A parent can only be discovered once its episode is listed, which may be
      -- a later run than the clip. Never unset one we already found.
      parent_video_id = COALESCE(EXCLUDED.parent_video_id, channel_videos.parent_video_id),
      chapters = EXCLUDED.chapters,
      updated_at = now()
  `;
}

export interface TriageVerdict {
  videoId: string;
  verdict: "relevant" | "off_topic" | "unclear";
  confidence: number;
  note: string;
  analogIds: string[];
  windows: TriageWindow[];
  descFacts: string[];
}

export async function storeTriage(t: TriageVerdict): Promise<void> {
  await sql`
    UPDATE channel_videos SET
      triaged_at = now(),
      triage_verdict = ${t.verdict},
      triage_confidence = ${t.confidence},
      triage_note = ${t.note.slice(0, 400)},
      analog_ids = ${t.analogIds},
      windows = ${JSON.stringify(t.windows)}::jsonb,
      desc_facts = ${t.descFacts},
      -- An off-topic video is finished business. Marking it here is what stops
      -- Philip Meissner's aphorism clips reappearing in every queue forever.
      source_state = CASE WHEN ${t.verdict} = 'relevant' THEN 'pending' ELSE 'skipped' END,
      transcribe_state = CASE WHEN ${t.verdict} = 'relevant' THEN 'pending' ELSE 'skipped' END,
      updated_at = now()
    WHERE video_id = ${t.videoId}
  `;
}

/**
 * Untriaged videos, newest first. The phase-1 work queue.
 *
 * The timestamps are cast to text deliberately. `sql<T>` is an unchecked cast,
 * so a declared `string` that Postgres returns as a Date compiles cleanly and
 * fails at runtime — which is exactly what happened on the first live run:
 * publishedAt arrives as an ISO string from the YouTube API and as a Date from
 * this query, and the triage prompt's `.slice(0, 10)` threw on all six batches.
 * The dry run could never have caught it, because it never reads this table.
 * Casting here makes the declared type true rather than guarding every use.
 */
export async function untriagedVideos(limit = 40): Promise<ChannelVideoRow[]> {
  return sql<ChannelVideoRow>`
    SELECT video_id AS "videoId", channel_id AS "channelId", title, description,
           published_at::text AS "publishedAt", duration_sec AS "durationSec",
           is_short AS "isShort", desc_key AS "descKey", parent_video_id AS "parentVideoId",
           chapters, triaged_at::text AS "triagedAt", triage_verdict AS "triageVerdict",
           triage_confidence AS "triageConfidence", triage_note AS "triageNote",
           analog_ids AS "analogIds", windows, desc_facts AS "descFacts",
           source_state AS "sourceState", transcribe_state AS "transcribeState"
    FROM channel_videos
    WHERE triaged_at IS NULL
    ORDER BY published_at DESC NULLS LAST
    LIMIT ${limit}
  `;
}

export async function recordChannelSweep(s: {
  channelId: string;
  status: "ok" | "partial" | "failed";
  listed: number;
  fresh: number;
  relevant: number;
  quotaUnits: number;
  error?: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO channel_sweep_state (channel_id, last_swept_at, last_status, last_listed,
                                     last_new, last_relevant, last_error, quota_units)
    VALUES (${s.channelId}, now(), ${s.status}, ${s.listed}, ${s.fresh}, ${s.relevant},
            ${s.error ?? null}, ${s.quotaUnits})
    ON CONFLICT (channel_id) DO UPDATE SET
      last_swept_at = now(), last_status = EXCLUDED.last_status,
      last_listed = EXCLUDED.last_listed, last_new = EXCLUDED.last_new,
      last_relevant = EXCLUDED.last_relevant, last_error = EXCLUDED.last_error,
      quota_units = channel_sweep_state.quota_units + EXCLUDED.quota_units,
      updated_at = now()
  `;
}
