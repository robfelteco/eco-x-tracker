// The shape of "how far along is this run", shared by the orchestrator that
// writes it and the panel that draws it.
//
// A discovery run is minutes long and spends real money, so a button that only
// says "Discovering…" is not enough: the reviewer needs to know which lane is
// working, what it is doing right now, and roughly how much longer. Everything
// here exists to answer those three questions.
//
// No database or network imports — this module is pulled into the client.

export type Lane = "x" | "youtube" | "web";
export const LANES: Lane[] = ["x", "youtube", "web"];

export interface StepDef {
  key: string;
  label: string;
  // Share of the lane's wall-clock this step typically takes. Used to turn
  // "step 2 of 3, 4 of 9 done" into a fraction of the lane.
  weight: number;
}

// Steps are declared up front rather than discovered as they happen, so the UI
// can show the whole plan from the first second instead of growing a list.
export const LANE_STEPS: Record<Lane, StepDef[]> = {
  x: [
    { key: "timelines", label: "Reading roster timelines", weight: 0.55 },
    { key: "sweep", label: "Sweeping for new names", weight: 0.1 },
    { key: "extract", label: "Extracting + verifying quotes", weight: 0.35 },
  ],
  youtube: [
    { key: "list", label: "Listing channel uploads", weight: 0.08 },
    { key: "transcribe", label: "Transcribing video", weight: 0.62 },
    { key: "extract", label: "Extracting + verifying quotes", weight: 0.3 },
  ],
  web: [
    { key: "map", label: "Mapping report hubs", weight: 0.25 },
    { key: "scrape", label: "Scraping articles", weight: 0.4 },
    { key: "extract", label: "Extracting + verifying quotes", weight: 0.35 },
  ],
};

// Used until a run has finished often enough to be timed. Deliberately on the
// generous side — an estimate that keeps slipping later reads as a hang.
export const DEFAULT_LANE_MS: Record<Lane, number> = {
  x: 60_000,
  youtube: 240_000,
  web: 90_000,
};

// A run is driven by the browser tab that started it: one request per lane, in
// sequence. Close that tab mid-run and nothing finishes the remaining lanes, so
// the row sits at 'running' forever. Past this age a run is treated as
// abandoned — by the orchestrator, which lets a new run start, and by the panel,
// which stops drawing a spinner for work that is not happening.
export const RUN_STALE_MS = 20 * 60_000;

export function runIsLive(status: string | undefined, startedAt: string | null | undefined, now: number): boolean {
  if (status !== "running") return false;
  const t = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(t)) return true;
  return now - t < RUN_STALE_MS;
}

export interface RunProgress {
  lane: Lane;
  step: string;
  done?: number;
  total?: number;
  // What it is chewing on right now — a person's name, a video title, a URL.
  note?: string;
  at?: string;
  laneStartedAt?: string;
}

// A lane is done — however it ended. 'partial' and 'failed' still consumed
// their time, so for progress purposes they count as finished.
export function laneIsDone(status: string | undefined): boolean {
  return status === "complete" || status === "partial" || status === "failed";
}

export function stepLabel(lane: Lane, key: string): string {
  return LANE_STEPS[lane].find((s) => s.key === key)?.label ?? key;
}

// How far into ONE lane the given progress record is, 0–1.
export function laneFraction(lane: Lane, p: RunProgress | null | undefined): number {
  if (!p || p.lane !== lane) return 0;
  let acc = 0;
  for (const s of LANE_STEPS[lane]) {
    if (s.key === p.step) {
      // A step with no countable unit (a single map call, say) is treated as
      // half done while it runs — better than pinning the bar at the step edge.
      const within = p.total && p.total > 0 ? Math.min(1, (p.done ?? 0) / p.total) : 0.5;
      return acc + s.weight * within;
    }
    acc += s.weight;
  }
  return acc;
}

// Overall run fraction, 0–1. Lanes are weighted by how long they actually take
// — YouTube is most of a run's wall-clock, so a three-equal-thirds bar would
// sprint to 66% and then sit there.
export function runFraction(
  laneStatus: Record<string, string> | undefined,
  progress: RunProgress | null | undefined,
  etaMs: Record<string, number>,
  laneElapsedMs: number | null,
): number {
  const eta = (l: Lane) => etaMs?.[l] ?? DEFAULT_LANE_MS[l];
  const total = LANES.reduce((s, l) => s + eta(l), 0);
  let f = 0;
  for (const l of LANES) {
    const w = eta(l) / total;
    const st = laneStatus?.[l];
    if (laneIsDone(st)) {
      f += w;
    } else if (st === "running") {
      // Take whichever is further along: the steps we've been told about, or
      // the clock. Step reports are truthful but arrive in jumps; the clock
      // keeps the bar visibly alive between them.
      const byStep = laneFraction(l, progress);
      const byClock = laneElapsedMs != null ? laneElapsedMs / eta(l) : 0;
      f += w * Math.min(0.97, Math.max(byStep, Math.min(0.95, byClock)));
    }
  }
  return Math.min(1, f);
}

// Milliseconds left, from the fraction done and the time already spent. Once a
// run outruns its estimate the estimate is rebuilt from the observed pace,
// rather than counting down to zero and lying there.
export function remainingMs(
  fraction: number,
  elapsedMs: number,
  etaMs: Record<string, number>,
): number {
  const baseline = LANES.reduce((s, l) => s + (etaMs?.[l] ?? DEFAULT_LANE_MS[l]), 0);
  const observed = fraction > 0.03 ? elapsedMs / fraction : baseline;
  const projected = Math.max(baseline, observed);
  return Math.max(0, projected - elapsedMs);
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m}m ${String(rest).padStart(2, "0")}s` : `${m}m`;
}
