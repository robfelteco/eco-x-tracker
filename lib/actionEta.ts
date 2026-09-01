// How long a backend action takes, and how far along it is.
//
// Every button in this app that calls an API was previously indistinguishable
// from a dead button: you clicked "Draft starting copy", the label changed, and
// then nothing moved for ninety seconds. This module is the data half of the fix
// (app/components/useAction.tsx is the React half).
//
// The estimates START as the defaults below and then CORRECT THEMSELVES from
// what actually happens in this browser. That matters because the two slowest
// actions have no fixed cost: /api/generate runs 3 to 8 times longer on the CLI
// backend than on the API one, and Find sources depends on how many pages the
// sweep reads. A constant would be wrong for at least one of them on every
// machine. Same approach the quote-discovery panel already takes with its
// per-lane medians, kept local here because these actions have no run row to
// write to.

export type ActionKind =
  | "generate"
  | "generate-all"
  | "discover"
  | "analog-sources"
  | "questions"
  | "sync"
  | "label"
  | "use"
  | "review"
  | "roster";

export interface ActionDef {
  /** Present participle, shown while it runs: "Drafting copy…". */
  verb: string;
  /** Starting estimate in ms, replaced by the local median after 3 runs. */
  defaultMs: number;
  /**
   * What the wait actually buys. Shown under the bar, because a ninety-second
   * wait reads as broken unless you know it is doing ninety seconds of work.
   */
  note?: string;
}

export const ACTIONS: Record<ActionKind, ActionDef> = {
  generate: {
    verb: "Drafting copy",
    // Measured 2026-08-28 after the "--effort low" and neutral-cwd fixes: the
    // CLI backend lands at 36-39s, the API at ~15s, and a CLI timeout that
    // falls back to the API costs about 105s. 45s is the middle of that, and
    // the local median corrects it after three runs anyway.
    defaultMs: 45_000,
    note: "Writing 3 drafts, scoring each, then running the anti-slop pass.",
  },
  // Its own kind, not "generate", for two reasons: the duration is a different
  // quantity (the slowest of N parallel calls, not one call), and mixing the two
  // would poison the learned median that the single-source bar reads.
  "generate-all": {
    verb: "Drafting from every source",
    // Parallel with a small concurrency cap, so this is roughly
    // ceil(sources / CONCURRENCY) single drafts back to back. Two waves of the
    // 45s single-draft figure.
    defaultMs: 95_000,
    note: "One separate draft per source, so each post argues from one piece.",
  },
  discover: {
    verb: "Finding recommendations",
    defaultMs: 45_000,
    note: "Scoring every shelf against freshness, gaps and what has been used.",
  },
  "analog-sources": {
    verb: "Finding sources",
    defaultMs: 60_000,
    note: "Searching for canonical and current material, then verifying each claim.",
  },
  questions: {
    verb: "Mining questions",
    defaultMs: 35_000,
    note: "Reading the source for the questions it leaves open.",
  },
  sync: {
    verb: "Syncing",
    defaultMs: 25_000,
    note: "Pulling new posts and refreshing metric snapshots.",
  },
  label: { verb: "Saving", defaultMs: 1_200 },
  use: { verb: "Saving", defaultMs: 1_200 },
  review: { verb: "Saving", defaultMs: 1_200 },
  roster: { verb: "Saving", defaultMs: 1_200 },
};

/**
 * Below this, a progress bar is worse than no progress bar: it flashes and
 * vanishes before the eye resolves it. Those actions get a pulse instead, and
 * they never chime.
 */
export const SHORT_ACTION_MS = 2_500;

export function isShortAction(kind: ActionKind): boolean {
  return expectedMs(kind) < SHORT_ACTION_MS;
}

// ---------------------------------------------------------------------------
// The learned estimate.
// ---------------------------------------------------------------------------

const STORE_KEY = "eco-tracker:action-timings:v1";
const KEEP = 7; // samples per action; a week of clicking, roughly
const MIN_SAMPLES = 3; // below this the default is still better than the median

type Timings = Partial<Record<ActionKind, number[]>>;

function readStore(): Timings {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Timings) : {};
  } catch {
    // Private mode, disabled storage, or a corrupt value. The defaults are a
    // complete fallback, so there is nothing to recover and nothing to report.
    return {};
  }
}

function writeStore(t: Timings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(t));
  } catch {
    /* over quota or blocked; estimates just stop improving */
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (!s.length) return 0;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Best current estimate for one action, in ms. */
export function expectedMs(kind: ActionKind): number {
  const fallback = ACTIONS[kind].defaultMs;
  const samples = readStore()[kind] ?? [];
  if (samples.length < MIN_SAMPLES) return fallback;
  return Math.max(500, Math.round(median(samples)));
}

/**
 * Record one completed run. Failures are NOT recorded: a request that died on a
 * timeout says nothing about how long the work takes, and folding it in would
 * drag every future estimate toward the timeout ceiling.
 */
export function recordDuration(kind: ActionKind, ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const store = readStore();
  const next = [...(store[kind] ?? []), Math.round(ms)].slice(-KEEP);
  writeStore({ ...store, [kind]: next });
}

// ---------------------------------------------------------------------------
// The curve.
// ---------------------------------------------------------------------------

/**
 * How full the bar is at `elapsed`, given an expected duration.
 *
 * Two properties matter more than accuracy. It never reaches 1.0 while the work
 * is still running, because a bar sitting at 100% next to a spinner reads as
 * hung. And it never stalls: past the estimate it keeps creeping on a decaying
 * curve, so an overrun still looks alive.
 */
export function progressFraction(elapsedMs: number, expected: number): number {
  if (expected <= 0) return 0;
  const r = elapsedMs / expected;
  if (r <= 1) {
    // Ease out: quick off the mark, slowing as it approaches the estimate.
    const eased = 1 - (1 - r) * (1 - r);
    return Math.min(0.88, 0.88 * eased);
  }
  // Overrun: asymptotic toward 0.99, never arriving.
  return Math.min(0.99, 0.88 + 0.11 * (1 - Math.exp(-(r - 1))));
}

/** Milliseconds left, or null once the estimate has been overrun. */
export function remainingMs(elapsedMs: number, expected: number): number | null {
  const left = expected - elapsedMs;
  return left > 0 ? left : null;
}

/** "45s", "1m 30s". Matches lib/quoteProgress.ts so the two panels agree. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m}m ${String(rest).padStart(2, "0")}s` : `${m}m`;
}
