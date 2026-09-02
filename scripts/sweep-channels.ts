/**
 * The channel lane (Lane 1 podcast sourcing) — enumerate and triage.
 *
 *   node --env-file=.env scripts/sweep-channels.ts --dry-run   # writes NOTHING
 *   node --env-file=.env scripts/sweep-channels.ts             # writes the ledger
 *   node --env-file=.env scripts/sweep-channels.ts --days 90 --max 40
 *   node --env-file=.env scripts/sweep-channels.ts --force     # re-triage everything
 *
 * Phase 1 stops at the ledger. Nothing here writes to analog_sources and nothing
 * calls Gemini, so the whole run is three YouTube quota units per channel plus a
 * handful of Claude calls — cheap enough to re-run while the triage prompt is
 * being tuned.
 *
 * --dry-run is the intended first move: it lists, groups, parses chapters and
 * triages, then prints the verdicts and exits without touching the database. The
 * point is to read the concept routing before any of it becomes a source row.
 */
import { runChannelSweep } from "../lib/channelSweep.ts";
import { CHANNEL_BY_ID } from "../lib/channels.ts";
import { detectAnalog } from "../lib/analogs.ts";

const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
const lookbackDays = Number(arg("--days") ?? 45);
const maxTriage = Number(arg("--max") ?? 40);

const VERDICT_MARK: Record<string, string> = {
  relevant: "KEEP",
  off_topic: "drop",
  unclear: "????",
};

function fmtDur(sec: number | null): string {
  if (sec == null) return "?";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  return sec % 60 ? `${m}m${sec % 60}s` : `${m}m`;
}

// "What's Next with Philip Meissner" truncated to 16 chars reads as "What's Next
// with", which loses the only word that identifies the channel. Shorten by the
// distinctive part instead of by slicing.
const LABEL_SHORT: Record<string, string> = { "What's Next with Philip Meissner": "Meissner" };
function shortLabel(label: string): string {
  return LABEL_SHORT[label] ?? label.slice(0, 12);
}

function fmtTs(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

const r = await runChannelSweep({ dryRun, force, lookbackDays, maxTriage });

console.log(
  `\n${dryRun ? "DRY RUN — nothing written." : "LIVE RUN"}  lookback ${lookbackDays}d\n` +
    "=".repeat(96),
);

console.log("\nListed:");
for (const e of r.enumerated) {
  console.log(
    `  ${e.label.padEnd(34)} ${String(e.listed).padStart(3)} listed · ${String(e.excluded).padStart(2)} excluded · ` +
      `${String(e.fresh).padStart(3)} new · ${String(e.linked).padStart(2)} clips linked · ${e.quotaUnits} quota units`,
  );
}

console.log(`\nTriaged ${r.queue.length} video(s) in ${r.triage.calls} call(s):\n`);

const byId = new Map(r.queue.map((q) => [q.videoId, q]));
const order = { relevant: 0, unclear: 1, off_topic: 2 } as Record<string, number>;
const sorted = [...r.triage.verdicts].sort(
  (a, b) => (order[a.verdict] ?? 3) - (order[b.verdict] ?? 3) || b.confidence - a.confidence,
);

for (const v of sorted) {
  const row = byId.get(v.videoId);
  if (!row) continue;
  const ch = CHANNEL_BY_ID[row.channelId]?.label ?? row.channelId;
  console.log(
    `[${VERDICT_MARK[v.verdict]}] ${String(v.confidence).padStart(3)}%  ${shortLabel(ch).padEnd(12)} ` +
      `${(row.isShort ? "CLIP" : "EP").padEnd(4)} ${fmtDur(row.durationSec).padStart(6)}  ${row.title.slice(0, 66)}`,
  );
  if (v.analogIds.length) console.log(`         -> ${v.analogIds.join(", ")}`);
  if (v.note) console.log(`            ${v.note.slice(0, 110)}`);
  for (const w of v.windows) {
    console.log(
      `            window ${fmtTs(w.startSec)}-${fmtTs(w.endSec)} (${Math.round((w.endSec - w.startSec) / 60)}m) ` +
        `${w.analogId}: ${w.why.slice(0, 70)}`,
    );
  }
  for (const f of v.descFacts.slice(0, 3)) console.log(`            fact: ${f.slice(0, 100)}`);

  // The deterministic matcher, reported only. It is not shown to the model and
  // does not gate anything; this line exists so the 3-of-36 measurement that
  // justified using a model call stays visible rather than becoming folklore.
  const det = detectAnalog(row.title);
  if (v.verdict === "relevant") {
    const agree = det && v.analogIds.includes(det);
    console.log(`            vocab-on-title: ${det ?? "no match"}${det && !agree ? " (DISAGREES)" : ""}`);
  }
  console.log();
}

const keep = r.triage.verdicts.filter((v) => v.verdict === "relevant");
const windows = keep.flatMap((v) => v.windows);
const windowMin = Math.round(windows.reduce((n, w) => n + (w.endSec - w.startSec), 0) / 60);
const epMin = Math.round(
  keep
    .filter((v) => !byId.get(v.videoId)?.isShort)
    .reduce((n, v) => n + (byId.get(v.videoId)?.durationSec ?? 0), 0) / 60,
);
const clipMin = Math.round(
  keep
    .filter((v) => byId.get(v.videoId)?.isShort)
    .reduce((n, v) => n + (byId.get(v.videoId)?.durationSec ?? 0), 0) / 60,
);

console.log("=".repeat(96));
console.log(
  `Verdicts: ${keep.length} relevant · ` +
    `${r.triage.verdicts.filter((v) => v.verdict === "unclear").length} unclear · ` +
    `${r.triage.verdicts.filter((v) => v.verdict === "off_topic").length} off-topic` +
    (r.triage.missing.length ? ` · ${r.triage.missing.length} MISSING a verdict` : ""),
);
console.log(
  `Concepts touched: ${[...new Set(keep.flatMap((v) => v.analogIds))].sort().join(", ") || "(none)"}`,
);
console.log(
  `Description-tier facts available with no transcription: ` +
    `${keep.reduce((n, v) => n + v.descFacts.length, 0)} across ${keep.filter((v) => v.descFacts.length).length} video(s)`,
);
console.log(
  `Phase-3 transcription if approved: ${windowMin}m of windows + ${clipMin}m of clips, ` +
    `against ${epMin}m if whole episodes were transcribed instead.`,
);
console.log(
  `Spend: ${r.triage.calls} Claude call(s), ${r.triage.inputTokens} in / ${r.triage.outputTokens} out · ` +
    `${r.enumerated.reduce((n, e) => n + e.quotaUnits, 0)} YouTube quota units of 10,000/day · ` +
    `0 Firecrawl credits · 0 Gemini calls`,
);
if (!dryRun) console.log(`Stored ${r.stored} verdict(s) to channel_videos.`);
for (const w of r.warnings.slice(0, 12)) console.log(`  ! ${w.slice(0, 150)}`);

// ---------------------------------------------------------------------------
// Phases 2 and 3, opt-in from the same CLI.
//
//   --sources     write description-tier rows to analog_sources (no Gemini)
//   --transcribe  Gemini over the flagged windows, then facts + quote candidates
//   --limit N     videos to transcribe (default 3; each is 1-3 Gemini calls)
//
// Deliberately not implied by a bare run: --transcribe is the only flag in this
// script that spends real money, so it has to be typed.
// ---------------------------------------------------------------------------
if (process.argv.includes("--sources")) {
  const { promoteDescriptionSources } = await import("../lib/channelSources.ts");
  const p = await promoteDescriptionSources({ dryRun });
  console.log(`\n${dryRun ? "DRY " : ""}Description-tier sources`);
  console.log("=".repeat(96));
  for (const r of p.promoted) {
    if (r.skipped) {
      console.log(`  --   ${r.channel.slice(0, 12).padEnd(12)} ${r.title.slice(0, 54).padEnd(54)} ${r.skipped}`);
    } else {
      console.log(`  +${String(r.rows).padStart(2)}  ${r.channel.slice(0, 12).padEnd(12)} ${r.title.slice(0, 54).padEnd(54)} ${r.analogIds.join(", ")}`);
    }
  }
  console.log(`\n${p.rows} source row(s) written · ${p.deferred} deferred to a transcript`);
  for (const w of p.warnings.slice(0, 8)) console.log(`  ! ${w.slice(0, 150)}`);
}

if (process.argv.includes("--transcribe")) {
  const { runChannelTranscription } = await import("../lib/channelTranscribe.ts");
  const limit = Number(arg("--limit") ?? 3);
  const t = await runChannelTranscription({ limit, dryRun });
  console.log(`\n${dryRun ? "DRY " : ""}Transcription${dryRun ? " (plan only — no Gemini call)" : ""}`);
  console.log("=".repeat(96));
  for (const o of t.outcomes) {
    console.log(
      `  ${o.channel.slice(0, 12).padEnd(12)} ${o.title.slice(0, 50).padEnd(50)} ` +
        `${String(o.windows).padStart(2)}w ${String(o.minutes).padStart(5)}m` +
        (o.reused ? " REUSED" : "") +
        (o.skipped ? `  skipped: ${o.skipped}` : `  +${o.factRows} facts · ${o.quoteCandidates} quotes · ${o.verifyFailed} failed gate`) +
        (o.partial ? `  PARTIAL: ${o.partial}` : ""),
    );
  }
  console.log(
    `\n${t.minutes}m of audio · ${t.factRows} source row(s) · ${t.quoteCandidates} quote candidate(s)` +
      (t.aborted ? "  *** ABORTED ***" : ""),
  );
  for (const w of t.warnings.slice(0, 8)) console.log(`  ! ${w.slice(0, 150)}`);
}
