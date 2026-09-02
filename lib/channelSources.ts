import { sql } from "./db.ts";
import { ANALOG_BY_ID } from "./analogs.ts";
import { storeAnalogSource, type StorableSource } from "./analogSweep.ts";
import {
  CHANNEL_BY_ID,
  type ChannelVideoRow,
  type TriageWindow,
} from "./channels.ts";

// Phase 2 — turning a triage verdict into curriculum source material.
//
// This is where the channel lane starts feeding the shelf, so it is where the
// tier discipline has to hold. Three rules, all enforced here or in
// storeAnalogSource() rather than asked for in a prompt:
//
//   1. kind='podcast' can never be 'canonical'. See NEVER_CANONICAL in
//      lib/analogSweep.ts. Canonical means "the institution explaining its own
//      mechanism, still true in five years"; a sponsored interview is not that,
//      however good it is. These channels fill the CURRENT layer, which is the
//      layer the institutional lane structurally cannot fill (a BIS primer on
//      RTGS is perfect and evergreen, so `canonicalOnly` never falls).
//
//   2. Description-derived facts belong to the EPISODE, never to a clip cut from
//      it. Discovered in the first dry run: "processed more than $3B over the
//      last 12 months" came back on five Money Code clips AND their parent
//      episode, because all six carry the same description byte for byte.
//      Storing it six times would put one claim behind six citations and inflate
//      every count on the curriculum shelf, which exists to be an honest
//      coverage board. A clip's description does not describe the clip, so a
//      clip contributes nothing until it is transcribed (phase 3).
//
//   3. The publisher's commercial position travels with the row. A guest's claim
//      about their own product is a claim, not a measurement, and the drafter has
//      to be able to tell the difference between "BIS measured cross-border
//      costs at X" and "a BVNK-sponsored guest said prefunding took days".
//      That is what the summary prefix is for.

/** How many concepts one video may be filed under. Mirrors the triage cap. */
const MAX_CONCEPTS_PER_VIDEO = 3;

export interface PromoteResult {
  videoId: string;
  title: string;
  channel: string;
  analogIds: string[];
  rows: number;
  factsSource: "description" | "transcript";
  skipped?: string;
}

export interface PromoteRunResult {
  promoted: PromoteResult[];
  rows: number;
  deferred: number;
  warnings: string[];
}

function videoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * The summary handed to the drafter.
 *
 * Deliberately leads with WHAT KIND OF SOURCE this is. sourcesForDrafting()
 * gives the model a title, a publisher and a summary; without the framing here,
 * "Stablecoins reduce prefunding from days to hours" reads identically whether it
 * came from a BIS quarterly or from a payment network's head of product on a
 * sponsored podcast. The drafter needs the second one to be attributable as a
 * practitioner's account, not quotable as a measured fact.
 */
function buildSummary(
  row: ChannelVideoRow,
  factsSource: "description" | "transcript",
): string {
  const def = CHANNEL_BY_ID[row.channelId];
  const label = def?.label ?? "a podcast";
  const kind = row.isShort ? "clip" : "episode";
  const stance = def?.interestedParty
    ? ` ${label} is commercially involved in this market, so claims by hosts and guests are practitioner accounts rather than independent measurements.`
    : "";
  const provenance =
    factsSource === "description"
      ? " Facts are taken from the published episode description, not from a transcript — do not attribute a spoken number to anyone."
      : " Facts are taken from a transcript of the cited minutes.";
  const note = row.triageNote ? ` ${row.triageNote}` : "";
  return `Podcast ${kind} from ${label}.${note}${stance}${provenance}`.slice(
    0,
    1200,
  );
}

/**
 * Facts for one concept.
 *
 * At transcript tier the windows carry an analogId, so a fact can be filed
 * against the concept whose minutes produced it. At description tier there is no
 * such attribution — the description describes the whole episode — so the same
 * claims go to every concept the episode was filed under. That is honest: the
 * piece really is relevant to each, and sourcesForDrafting() caps what any one
 * draft sees anyway.
 */
function factsForConcept(
  row: ChannelVideoRow,
  analogId: string,
  transcriptFacts: Map<string, string[]> | null,
): string[] {
  if (transcriptFacts) return transcriptFacts.get(analogId) ?? [];
  return row.descFacts;
}

export interface PromoteOptions {
  /** Stop starting new work past this timestamp. */
  deadline?: number;
  limit?: number;
  dryRun?: boolean;
}

/** Triaged-relevant videos whose source rows have not been written yet. */
export async function pendingForSources(
  limit = 40,
): Promise<ChannelVideoRow[]> {
  return sql<ChannelVideoRow>`
    SELECT video_id AS "videoId", channel_id AS "channelId", title, description,
           published_at::text AS "publishedAt", duration_sec AS "durationSec",
           is_short AS "isShort", desc_key AS "descKey", parent_video_id AS "parentVideoId",
           chapters, triaged_at::text AS "triagedAt", triage_verdict AS "triageVerdict",
           triage_confidence AS "triageConfidence", triage_note AS "triageNote",
           analog_ids AS "analogIds", windows, desc_facts AS "descFacts",
           source_state AS "sourceState", transcribe_state AS "transcribeState"
    FROM channel_videos
    WHERE triage_verdict = 'relevant' AND source_state = 'pending'
    ORDER BY triage_confidence DESC NULLS LAST, published_at DESC NULLS LAST
    LIMIT ${limit}
  `;
}

/**
 * Write source rows for one video.
 *
 * `transcriptFacts` is null on the description rung and a per-concept map on the
 * transcript rung (phase 3), which is the only difference between the two — the
 * row shape, the tier and the publisher framing are identical.
 */
export async function promoteVideo(
  row: ChannelVideoRow,
  transcriptFacts: Map<string, string[]> | null,
  opts: PromoteOptions = {},
): Promise<PromoteResult> {
  const def = CHANNEL_BY_ID[row.channelId];
  const channel = def?.label ?? row.channelId;
  const factsSource = transcriptFacts ? "transcript" : "description";
  const base: PromoteResult = {
    videoId: row.videoId,
    title: row.title,
    channel,
    analogIds: [],
    rows: 0,
    factsSource,
  };

  // Rule 2. A clip carries its parent's description, so its "description facts"
  // are a different recording's facts. It waits for a transcript.
  if (!transcriptFacts && row.isShort) {
    return {
      ...base,
      skipped:
        "clip — description belongs to the parent episode; awaiting transcript",
    };
  }

  const analogIds = row.analogIds
    .filter((id) => !!ANALOG_BY_ID[id])
    .slice(0, MAX_CONCEPTS_PER_VIDEO);
  if (!analogIds.length) {
    return { ...base, skipped: "no valid concept id" };
  }

  const summary = buildSummary(row, factsSource);
  let rows = 0;
  const filed: string[] = [];

  for (const analogId of analogIds) {
    const keyFacts = factsForConcept(row, analogId, transcriptFacts);
    // A source with no checkable claim is exactly what the sweep's extraction
    // gate rejects, and the same bar applies here: analog_sources exists so a
    // draft can argue FROM something, and a row with an empty key_facts array
    // gives the drafter a citation and nothing to say with it.
    if (!keyFacts.length) continue;

    const src: StorableSource = {
      url: videoUrl(row.videoId),
      // Set for completeness; storeAnalogSource forces 'current' for a podcast.
      tier: "current",
      title: row.title,
      publisher: channel,
      publishedOn: (row.publishedAt ?? "").slice(0, 10),
      kind: "podcast",
      summary,
      keyFacts,
    };
    if (!opts.dryRun) {
      await storeAnalogSource(analogId, src, factsSource, "channel_sweep");
    }
    rows++;
    filed.push(analogId);
  }

  if (!rows) {
    return { ...base, analogIds, skipped: "no checkable facts to cite" };
  }
  if (!opts.dryRun) {
    await sql`
      UPDATE channel_videos
      SET source_state = 'stored', updated_at = now()
      WHERE video_id = ${row.videoId}
    `;
  }
  return { ...base, analogIds: filed, rows };
}

/**
 * The description rung, over everything triage marked relevant.
 *
 * Most episodes should stop here. 31 checkable claims were available across 17
 * videos on the first live triage with no transcription at all, which is a real
 * curriculum input for the price of a metadata call.
 */
export async function promoteDescriptionSources(
  opts: PromoteOptions = {},
): Promise<PromoteRunResult> {
  const rows = await pendingForSources(opts.limit ?? 40);
  const promoted: PromoteResult[] = [];
  const warnings: string[] = [];
  let total = 0;
  let deferred = 0;

  for (const row of rows) {
    if (opts.deadline != null && Date.now() > opts.deadline) {
      warnings.push(
        `Out of time with ${rows.length - promoted.length} video(s) left; they stay pending.`,
      );
      break;
    }
    try {
      const r = await promoteVideo(row, null, opts);
      promoted.push(r);
      total += r.rows;
      if (r.skipped) deferred++;
    } catch (err) {
      warnings.push(`${row.videoId}: ${String(err).slice(0, 160)}`);
    }
  }

  return { promoted, rows: total, deferred, warnings };
}

// ---------------------------------------------------------------------------
// Read-back, for the report and for phase 3's queue
// ---------------------------------------------------------------------------

export interface ChannelSourceRow {
  analogId: string;
  title: string;
  publisher: string | null;
  url: string;
  tier: string;
  factsSource: string | null;
  keyFacts: string[];
}

export async function channelSourcesByConcept(): Promise<
  Map<string, ChannelSourceRow[]>
> {
  const rows = await sql<ChannelSourceRow>`
    SELECT analog_id AS "analogId", title, publisher, url, tier,
           facts_source AS "factsSource", key_facts AS "keyFacts"
    FROM analog_sources
    WHERE source_of = 'channel_sweep'
    ORDER BY analog_id, added_at DESC
  `;
  const out = new Map<string, ChannelSourceRow[]>();
  for (const r of rows) {
    const list = out.get(r.analogId) ?? [];
    list.push(r);
    out.set(r.analogId, list);
  }
  return out;
}

/** Videos with windows worth transcribing, plus relevant clips. Phase 3's queue. */
export async function pendingForTranscription(
  limit = 10,
): Promise<ChannelVideoRow[]> {
  return sql<ChannelVideoRow>`
    SELECT video_id AS "videoId", channel_id AS "channelId", title, description,
           published_at::text AS "publishedAt", duration_sec AS "durationSec",
           is_short AS "isShort", desc_key AS "descKey", parent_video_id AS "parentVideoId",
           chapters, triaged_at::text AS "triagedAt", triage_verdict AS "triageVerdict",
           triage_confidence AS "triageConfidence", triage_note AS "triageNote",
           analog_ids AS "analogIds", windows, desc_facts AS "descFacts",
           source_state AS "sourceState", transcribe_state AS "transcribeState"
    FROM channel_videos
    WHERE triage_verdict = 'relevant'
      AND transcribe_state = 'pending'
      -- Either the model found minutes worth paying for, or it is a clip, which
      -- IS its own window and costs almost nothing.
      AND (jsonb_array_length(windows) > 0 OR is_short = true)
    ORDER BY triage_confidence DESC NULLS LAST, is_short DESC, published_at DESC NULLS LAST
    LIMIT ${limit}
  `;
}

export function windowsOf(row: ChannelVideoRow): TriageWindow[] {
  return Array.isArray(row.windows) ? row.windows : [];
}
