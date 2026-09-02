import Anthropic from "@anthropic-ai/sdk";
import { sql } from "./db.ts";
import { ANALOG_BY_ID } from "./analogs.ts";
import {
  transcribeVideo,
  segmentsToBody,
  VideoNotIngestedError,
  type ClipWindow,
  type Segment,
} from "./quoteExtract.ts";
import { ingestDocQuotes } from "./quoteDiscovery.ts";
import { getRoster } from "./quoteRoster.ts";
import { type LaneDoc } from "./quoteLanes.ts";
import { CHANNEL_BY_ID, type ChannelVideoRow, type TriageWindow } from "./channels.ts";
import { pendingForTranscription, promoteVideo, windowsOf } from "./channelSources.ts";

// Phase 3 — the only rung that costs real money, and the one the previous three
// exist to make small.
//
// A clip is transcribed whole (23-89 seconds on these channels). An episode is
// transcribed only across the chapter windows triage flagged, which on the first
// live run was 141 minutes against 584 minutes of whole episodes.
//
// ONE TRANSCRIPT, TWO CONSUMERS. The transcript lands in raw_documents, which is
// where the quote pipeline already reads from, so a single Gemini pass produces
// both curriculum facts (analog_sources, facts_source='transcript') and quote
// candidates (through ingestDocQuotes, and therefore through the same verbatim
// gate). Paying twice for the same audio was the thing to avoid.
//
// THE FABRICATED-TRANSCRIPT GATE IS NOT OPTIONAL. transcribeVideo() throws
// VideoNotIngestedError when Gemini contributes no tokens from the video, because
// a model that cannot read the file still returns a plausible transcript, and
// verification against that transcript is circular. When it throws, this module
// stops the whole run rather than continuing — the same decision runLaneYouTube
// makes, for the same reason.

const MODEL = process.env.CHANNEL_FACTS_MODEL || process.env.SWEEP_MODEL || "claude-sonnet-4-6";

// A single video's transcription budget. Three windows is the triage cap; this is
// the belt to that braces, so a bad verdict cannot bill for forty minutes.
const MAX_WINDOWS = 3;
const MAX_WINDOW_SEC = 12 * 60;

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
    _client = new Anthropic();
  }
  return _client;
}

function videoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * Participants for diarization, from the description.
 *
 * transcribeVideo() is told to return a null speaker rather than guess, and a
 * null-speaker segment can never become a quote candidate. So a thin participant
 * list costs recall, and a WRONG one costs credibility — which is why this only
 * passes names it can actually see.
 */
function participantsOf(row: ChannelVideoRow): string[] {
  const def = CHANNEL_BY_ID[row.channelId];
  const names = new Set<string>();
  // "w/ Manuel Godoy", "Ft. Christian Catalini", "with Chuk Okpalugo"
  const m = row.title.match(/\b(?:w\/|ft\.?|with|feat\.?)\s+([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,2})/i);
  if (m) names.add(m[1].trim());
  // Hosts are named in the description on both podcast channels.
  const hosts = (row.description ?? "").match(
    /hosts?\s+([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+)?(?:\s+and\s+[A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+)?)?)/,
  );
  if (hosts) for (const n of hosts[1].split(/\s+and\s+/)) names.add(n.trim());
  void def;
  return [...names].filter((n) => n.split(/\s+/).length >= 2).slice(0, 6);
}

// ---------------------------------------------------------------------------
// Already-transcribed check
//
// This is also the fix for a pre-existing cost bug in the quote lane, which
// transcribes BEFORE checking raw_documents and dedupes only at INSERT. With a
// 365-day default lookback that means the same episode is re-transcribed on
// every run while newer ones are crowded out by the 12-video cap. Adding three
// channels would have made both halves worse, so the check lives here and is
// exported for the quote lane to adopt.
// ---------------------------------------------------------------------------

export interface ExistingDoc {
  id: number;
  body: string;
  segments: Segment[] | null;
}

export async function existingTranscript(videoId: string): Promise<ExistingDoc | null> {
  const rows = await sql<{ id: number; body: string; segments: Segment[] | null }>`
    SELECT id, body, segments FROM raw_documents
    WHERE source_kind = 'youtube' AND external_id = ${videoId}
    LIMIT 1
  `;
  if (!rows.length) return null;
  return { id: Number(rows[0].id), body: rows[0].body, segments: rows[0].segments ?? null };
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

function clampWindows(row: ChannelVideoRow): ClipWindow[] {
  return windowsOf(row)
    .slice(0, MAX_WINDOWS)
    .map((w: TriageWindow) => ({
      startSec: Math.max(0, Math.floor(w.startSec)),
      endSec: Math.min(
        row.durationSec ?? w.endSec,
        Math.ceil(Math.min(w.endSec, w.startSec + MAX_WINDOW_SEC)),
      ),
    }))
    .filter((w) => w.endSec > w.startSec + 20);
}

export interface TranscribeOutcome {
  videoId: string;
  title: string;
  channel: string;
  windows: number;
  minutes: number;
  segments: number;
  reused: boolean;
  factRows: number;
  quoteCandidates: number;
  verifyFailed: number;
  skipped?: string;
  /** Windows that failed on their own, when others succeeded. */
  partial?: string;
}

/**
 * Pull checkable claims out of a transcript, filed per concept.
 *
 * Separate from the triage call on purpose: triage decides WHETHER to spend money
 * from metadata, and this runs over words actually spoken. Facts here are
 * transcript-grade, so they may be attributed to a speaker — which is precisely
 * what description-tier facts must never be.
 */
async function extractTranscriptFacts(
  row: ChannelVideoRow,
  body: string,
): Promise<Map<string, string[]>> {
  const concepts = row.analogIds
    .filter((id) => !!ANALOG_BY_ID[id])
    .map((id) => {
      const d = ANALOG_BY_ID[id];
      return `- ${id} — ${d.label}\n    is: ${d.parallel}`;
    })
    .join("\n");
  if (!concepts) return new Map();

  const prompt = `Below is a transcript of a podcast segment. Pull out the CHECKABLE CLAIMS it makes about each mechanism listed, for a team writing educational posts that cite their sources.

THE MECHANISMS THIS SEGMENT WAS FILED UNDER:
${concepts}

A checkable claim is a specific number, named system, corridor, currency count, volume, timeframe, cost, or a concrete description of how something operates. "Prefunding took us three days across 40 corridors" is a claim. "Stablecoins are exciting for payments" is not.

RULES
- Quote or closely paraphrase what was actually said. Never round, never infer, never add a number that is not in the text.
- Attribute the claim's substance to the mechanism it belongs to. A claim may serve more than one; repeat it under each only if it genuinely does.
- These speakers are usually describing their OWN operations. Keep that visible in the wording: "NALA says 96 of 100 stablecoin trades in its markets are USDT", not "96% of trades are USDT".
- Return an empty array for a mechanism the segment does not actually evidence. An empty answer is correct and useful; a stretched one is not.
- At most 5 claims per mechanism.

TRANSCRIPT
"""
${body.slice(0, 60_000)}
"""

Return ONLY JSON, no prose, no code fences:
{"facts":{"<mechanism_id>":["claim","claim"]}}`;

  const msg = await client().messages.create({
    model: MODEL,
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });
  const block = msg.content.find((b) => b.type === "text");
  let t = (block && block.type === "text" ? block.text : "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const a = t.indexOf("{");
  const z = t.lastIndexOf("}");
  if (a === -1 || z === -1) return new Map();

  const out = new Map<string, string[]>();
  try {
    const obj = JSON.parse(t.slice(a, z + 1));
    const facts = obj?.facts ?? {};
    for (const [id, list] of Object.entries(facts)) {
      // Never trust a returned id: an invented one would create a phantom row on
      // a coverage board whose only job is honesty.
      if (!ANALOG_BY_ID[id] || !row.analogIds.includes(id)) continue;
      const claims = (Array.isArray(list) ? list : [])
        .map((f) => String(f).trim())
        .filter(Boolean)
        .slice(0, 5);
      if (claims.length) out.set(id, claims);
    }
  } catch {
    return new Map();
  }
  return out;
}

export interface TranscribeOptions {
  deadline?: number;
  limit?: number;
  dryRun?: boolean;
  /** Skip the quote-candidate pass. Facts only. */
  noQuotes?: boolean;
}

async function markTranscribe(
  videoId: string,
  state: "done" | "skipped" | "failed",
  docId: number | null,
  error: string | null,
): Promise<void> {
  await sql`
    UPDATE channel_videos
    SET transcribe_state = ${state},
        raw_document_id = COALESCE(${docId}, raw_document_id),
        last_error = ${error},
        updated_at = now()
    WHERE video_id = ${videoId}
  `;
}

export async function transcribeAndPromote(
  row: ChannelVideoRow,
  qctx: Parameters<typeof ingestDocQuotes>[1],
  opts: TranscribeOptions = {},
): Promise<TranscribeOutcome> {
  const def = CHANNEL_BY_ID[row.channelId];
  const channel = def?.label ?? row.channelId;
  const url = videoUrl(row.videoId);
  const base: TranscribeOutcome = {
    videoId: row.videoId,
    title: row.title,
    channel,
    windows: 0,
    minutes: 0,
    segments: 0,
    reused: false,
    factRows: 0,
    quoteCandidates: 0,
    verifyFailed: 0,
  };

  // A clip IS its own window; an episode needs the ones triage flagged.
  const windows = row.isShort ? [] : clampWindows(row);
  if (!row.isShort && !windows.length) {
    if (!opts.dryRun) await markTranscribe(row.videoId, "skipped", null, "no usable window");
    return { ...base, skipped: "no usable window" };
  }
  const minutes = row.isShort
    ? Math.round(((row.durationSec ?? 60) / 60) * 10) / 10
    : Math.round((windows.reduce((n, w) => n + (w.endSec - w.startSec), 0) / 60) * 10) / 10;

  if (opts.dryRun) {
    return { ...base, windows: windows.length, minutes };
  }

  // Reuse before paying. Also the reason a re-run is cheap.
  const already = await existingTranscript(row.videoId);
  let segments: Segment[];
  let reused = false;
  const windowErrors: string[] = [];
  if (already && already.body.trim().length > 200) {
    segments = already.segments ?? [];
    reused = true;
  } else {
    const participants = participantsOf(row);
    const collected: Segment[] = [];
    if (row.isShort) {
      collected.push(...(await transcribeVideo(url, participants, row.durationSec, null)));
    } else {
      // Per window, and NOT all-or-nothing. Each window is its own Gemini
      // request against a 280s ceiling, and a 12-minute window on a long
      // episode does sometimes hit it. Letting that throw discarded every
      // window that had already succeeded: a backfill run lost seven episodes
      // outright, including both of the ones whose ungrounded drafts started
      // this, when in most cases one window of three had timed out.
      //
      // A partial transcript is worth keeping. The drafter is told explicitly
      // that the passages it gets are all it has seen of the piece, and claims
      // are verified only against text we actually hold, so less material means
      // a narrower post — never a less grounded one.
      for (const w of windows) {
        if (opts.deadline != null && Date.now() > opts.deadline) break;
        try {
          collected.push(...(await transcribeVideo(url, participants, row.durationSec, w)));
        } catch (err) {
          // VideoNotIngestedError is the fabricated-transcript gate and must
          // still abort the whole lane — it means Gemini is not reading video
          // at all, so every further window would return invented text.
          if (err instanceof VideoNotIngestedError) throw err;
          windowErrors.push(`${Math.floor(w.startSec / 60)}m-${Math.floor(w.endSec / 60)}m: ${err instanceof Error ? err.message.slice(0, 90) : String(err).slice(0, 90)}`);
        }
      }
    }
    segments = collected.sort((a, b) => a.start_sec - b.start_sec);
  }

  if (!segments.length && !reused) {
    const why = windowErrors.length ? `every window failed — ${windowErrors[0]}` : "transcription returned nothing";
    await markTranscribe(row.videoId, "failed", null, why);
    return { ...base, windows: windows.length, minutes, skipped: why };
  }

  const body = reused && already ? already.body : segmentsToBody(segments);

  // --- curriculum facts -------------------------------------------------
  const facts = await extractTranscriptFacts(row, body);
  const promoted = await promoteVideo(row, facts, {});

  // --- quote candidates, through the shared verbatim gate ---------------
  let quoteCandidates = 0;
  let verifyFailed = 0;
  let docId: number | null = already?.id ?? null;
  if (!opts.noQuotes) {
    const doc: LaneDoc = {
      sourceKind: "youtube",
      sourceUrl: url,
      externalId: row.videoId,
      publishedAt: row.publishedAt,
      title: row.title,
      body,
      segments,
      knownSpeakers: [...new Set(segments.map((s) => s.speaker_name).filter((n): n is string => !!n))],
    };
    const got = await ingestDocQuotes(doc, qctx);
    docId = got.docId;
    quoteCandidates = got.candidates;
    verifyFailed = got.verifyFailed;
  }

  // "done" with a note, not "failed": we have usable text. The note is kept so
  // a later run can see this episode is only partly transcribed and revisit it.
  await markTranscribe(row.videoId, "done", docId, windowErrors.length ? `partial: ${windowErrors.join("; ")}` : null);
  return {
    ...base,
    windows: windows.length,
    minutes,
    segments: segments.length,
    reused,
    factRows: promoted.rows,
    quoteCandidates,
    verifyFailed,
    partial: windowErrors.length ? `${windowErrors.length}/${windows.length} window(s) failed` : undefined,
  };
}

export interface TranscribeRunResult {
  outcomes: TranscribeOutcome[];
  minutes: number;
  factRows: number;
  quoteCandidates: number;
  aborted: boolean;
  warnings: string[];
}

export async function runChannelTranscription(
  opts: TranscribeOptions = {},
): Promise<TranscribeRunResult> {
  const rows = await pendingForTranscription(opts.limit ?? 6);
  const outcomes: TranscribeOutcome[] = [];
  const warnings: string[] = [];
  let aborted = false;

  const roster = await getRoster();
  const qctx = {
    runId: null,
    byName: new Map(roster.map((p) => [p.fullName.toLowerCase(), p])),
    competitorNames: (
      await sql<{ name: string }>`SELECT name FROM orgs WHERE is_competitor = true`
    ).map((r) => r.name),
    perSpeaker: new Map<string, number>(),
    lookbackDays: 365,
  };

  for (const row of rows) {
    if (opts.deadline != null && Date.now() > opts.deadline) {
      warnings.push(`Out of time with ${rows.length - outcomes.length} video(s) left; they stay pending.`);
      break;
    }
    try {
      outcomes.push(await transcribeAndPromote(row, qctx, opts));
    } catch (err) {
      const msg = String(err).slice(0, 200);
      warnings.push(`${row.title.slice(0, 40)}: ${msg}`);
      if (!opts.dryRun) await markTranscribe(row.videoId, "failed", null, msg);

      // If Gemini is not actually reading video, it will fail identically for
      // every remaining item and the failure mode is INVENTED transcripts. Stop
      // the run rather than quietly returning fewer results, which would read as
      // a thin day instead of a broken one.
      if (err instanceof VideoNotIngestedError) {
        warnings.push(
          "Aborting channel transcription — this Gemini key/model tier is not ingesting YouTube video. " +
            "Anything it returned would be fabricated, so nothing from this run is trusted.",
        );
        aborted = true;
        break;
      }
      if (/GEMINI_API_KEY|401|quota|PERMISSION_DENIED/i.test(msg)) {
        warnings.push("Aborting channel transcription — Gemini refused further requests.");
        aborted = true;
        break;
      }
    }
  }

  return {
    outcomes,
    minutes: Math.round(outcomes.reduce((n, o) => n + o.minutes, 0) * 10) / 10,
    factRows: outcomes.reduce((n, o) => n + o.factRows, 0),
    quoteCandidates: outcomes.reduce((n, o) => n + o.quoteCandidates, 0),
    aborted,
    warnings,
  };
}
