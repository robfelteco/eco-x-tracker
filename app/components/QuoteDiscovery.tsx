"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { QuoteCard, type QuoteCandidate } from "./QuoteCard";
import {
  LANES, LANE_STEPS, DEFAULT_LANE_MS, laneIsDone, laneFraction, runFraction,
  remainingMs, formatDuration, stepLabel, runIsLive, type Lane, type RunProgress,
} from "@/lib/quoteProgress";
import { playChime, unlock } from "./notifySound";

// The Quote Card pillar's expanded section.
//
// A quote card is used ONCE, so unlike every other pillar there is nothing here
// to re-run and no shelf to rank — the whole job is discovery. This panel starts
// a run, drives its lanes one at a time, and streams candidates into a review
// queue as each lane lands.
//
// Per-lane status is shown rather than one undifferentiated result list, because
// the lanes have genuinely different reach: X is the shallow, recent lane (the
// official API's recent search only reaches back 7 days, and full-archive is
// Enterprise-only), while YouTube and published reports carry the historical
// recall. Pretending otherwise would misrepresent coverage.
//
// A run takes minutes, so it also reports its own progress. Each lane is a
// single long request; while one is in flight the panel polls the run row and
// draws what the lane has written down about where it is — which step, how many
// items in, and what it is chewing on. The estimate is the median of recent
// runs' actual per-lane durations, not a constant.

const LANE_LABEL: Record<Lane, string> = {
  x: "X — roster timelines",
  youtube: "YouTube — podcasts & panels",
  web: "Web — reports & transcripts",
};

const LANE_NOTE: Record<Lane, string> = {
  x: "Shallow but recent. Paginates roster timelines; since_id makes repeat runs near-free.",
  youtube: "Deep recall. Diarized transcript first, then extraction over the text.",
  web: "Institutional reports, earnings transcripts, show notes.",
};

interface RunState {
  id: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  laneStatus: Record<string, string>;
  progress: RunProgress | null;
  spendCents: number;
  budgetCents: number;
  lookbackDays: number;
  stats: Record<string, { docs?: number; candidates?: number; verifyFailed?: number; ms?: number }>;
  errors: string[];
}

interface RosterHealth {
  people: number;
  orgs: number;
  withX: number;
  suggestions: number;
}

function statusTone(s: string | undefined): string {
  switch (s) {
    case "complete": return "text-emerald-300/80";
    case "running": return "text-eco-lightblue";
    case "partial": return "text-amber-300/80";
    case "failed": return "text-red-400/80";
    default: return "text-white/30";
  }
}

// Milliseconds since an ISO timestamp written by the server. Clamped at zero:
// the browser's clock is not the database's, and a few seconds of skew must not
// render as a negative elapsed time.
function since(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, now - t) : null;
}

function LaneMark({ status }: { status: string | undefined }) {
  if (status === "running") {
    return (
      <span className="mt-[3px] inline-block h-3 w-3 shrink-0 animate-spin rounded-full border border-eco-lightblue/70 border-t-transparent" />
    );
  }
  const glyph = status === "complete" ? "✓" : status === "partial" ? "!" : status === "failed" ? "✕" : "·";
  return <span className={`mt-[1px] w-3 shrink-0 text-center text-[11px] leading-4 ${statusTone(status)}`}>{glyph}</span>;
}

export function QuoteDiscovery() {
  const [run, setRun] = useState<RunState | null>(null);
  const [queue, setQueue] = useState<QuoteCandidate[]>([]);
  const [counts, setCounts] = useState({ candidate: 0, approved: 0, rejected: 0 });
  const [roster, setRoster] = useState<RosterHealth | null>(null);
  const [eta, setEta] = useState<Record<string, number>>(DEFAULT_LANE_MS);
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lookbackDays, setLookbackDays] = useState(365);
  const [budgetUsd, setBudgetUsd] = useState(5);
  const [now, setNow] = useState(() => Date.now());
  const driving = useRef(false);
  const activeRunId = useRef<number | null>(null);

  const refresh = useCallback(async (runId?: number) => {
    try {
      const res = await fetch(`/api/quotes/status${runId ? `?runId=${runId}` : ""}`);
      const data = await res.json();
      if (!data.ok) return;
      if (data.run) {
        setRun(data.run);
        activeRunId.current = data.run.id;
      }
      setQueue(data.queue ?? []);
      setCounts(data.counts ?? { candidate: 0, approved: 0, rejected: 0 });
      setRoster(data.roster ?? null);
      if (data.eta) setEta(data.eta);
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // A run is only live if something is actually driving it. The lanes are driven
  // by the tab that started the run, so a closed tab leaves the row at
  // 'running' — and a spinner that never stops is worse than no spinner.
  // `starting` means this tab is the one driving the lanes right now, so it is
  // authoritative over any age heuristic.
  const abandoned = !starting && run?.status === "running" && !runIsLive(run.status, run.startedAt, now);
  const running = starting || (run?.status === "running" && !abandoned);

  // Poll the run row while it works. The lane requests are long and blocking, so
  // without this the panel would only learn anything at lane boundaries — which
  // is exactly the dead-button feeling this panel exists to fix.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => refresh(activeRunId.current ?? undefined), 2000);
    return () => clearInterval(id);
  }, [running, refresh]);

  // Separate, faster tick so elapsed time and the bar move between polls.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [running]);

  // Drive the lanes sequentially. Each lane is its own request so a long Gemini
  // pass can't blow a serverless duration limit, and results land per lane
  // instead of all-or-nothing at the end.
  async function start() {
    if (driving.current) return;
    driving.current = true;
    unlock();
    setStarting(true);
    setErr(null);
    try {
      const res = await fetch("/api/quotes/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lookbackDays, budgetCents: Math.round(budgetUsd * 100) }),
      });
      const data = await res.json();
      if (!data.ok) {
        // A run already in flight isn't an error — attach to it and show its
        // progress rather than starting a second paid pass.
        if (data.inProgress && data.runId) {
          setErr("A discovery run is already in progress — showing that one.");
          activeRunId.current = data.runId;
          await refresh(data.runId);
          return;
        }
        setErr(data.error || "Could not start a run");
        return;
      }
      const runId: number = data.runId;
      activeRunId.current = runId;
      await refresh(runId);
      for (const lane of LANES) {
        try {
          await fetch("/api/quotes/lane", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ runId, lane }),
          });
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e));
        }
        await refresh(runId);
      }
      // Every lane has landed. This is the longest action in the app by a wide
      // margin, so it is the one most likely to be started and walked away from.
      playChime();
    } finally {
      setStarting(false);
      driving.current = false;
    }
  }

  const spent = run ? (run.spendCents / 100).toFixed(2) : "0.00";
  const budget = run ? (run.budgetCents / 100).toFixed(2) : budgetUsd.toFixed(2);

  // A run's own progress only describes the run in flight. Once it finishes, the
  // last step it wrote is history and must not read as "still transcribing".
  const progress = running ? (run?.progress?.lane ? run.progress : null) : null;
  const elapsedMs = running ? (since(run?.startedAt, now) ?? 0) : null;
  const laneElapsedMs = progress ? since(progress.laneStartedAt, now) : null;

  const fraction = useMemo(() => {
    if (!run) return 0;
    if (run.status !== "running") return 1;
    // An abandoned run froze wherever it got to — show that, not a full bar.
    return runFraction(run.laneStatus, progress, eta, abandoned ? null : laneElapsedMs);
  }, [run, progress, eta, laneElapsedMs, abandoned]);

  const leftMs = running && elapsedMs != null ? remainingMs(fraction, elapsedMs, eta) : 0;
  const totalMs = run?.finishedAt ? (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) : null;

  return (
    <div className="space-y-3">
      {/* Roster health — the pipeline is only as good as this table. */}
      {roster && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-xs">
          <span className="font-mono text-[10px] uppercase tracking-wider text-white/30">Roster</span>
          <span className="text-white/65">
            {roster.people} people <span className="text-white/35">({roster.withX} on X)</span> · {roster.orgs} orgs
          </span>
          {roster.suggestions > 0 && (
            <Link href="/quotes" className="text-eco-lightblue/85 hover:text-eco-lightblue">
              {roster.suggestions} new name{roster.suggestions === 1 ? "" : "s"} to triage →
            </Link>
          )}
          <span className="ml-auto text-white/35">
            queue: <span className="text-white/70">{counts.candidate}</span> · approved {counts.approved} · rejected {counts.rejected}
          </span>
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={start}
          disabled={!!running}
          className="rounded-full bg-eco-blue px-3.5 py-1.5 text-xs font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? `Discovering… ${Math.round(fraction * 100)}%` : "Find quotes"}
        </button>
        <label className="flex items-center gap-1 text-[11px] text-white/40">
          lookback
          <select
            value={lookbackDays}
            onChange={(e) => setLookbackDays(Number(e.target.value))}
            disabled={!!running}
            className="rounded-md border border-white/12 bg-transparent px-1.5 py-0.5 text-[11px] text-white/70"
          >
            <option className="bg-[#0a0a0a]" value={90}>90d</option>
            <option className="bg-[#0a0a0a]" value={180}>180d</option>
            <option className="bg-[#0a0a0a]" value={365}>365d</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-[11px] text-white/40">
          budget $
          <input
            type="number"
            min={0.5}
            max={50}
            step={0.5}
            value={budgetUsd}
            onChange={(e) => setBudgetUsd(Number(e.target.value))}
            disabled={!!running}
            className="w-14 rounded-md border border-white/12 bg-transparent px-1.5 py-0.5 text-[11px] text-white/70"
          />
        </label>
        {run && (
          <span className="font-mono text-[10px] text-white/35">
            spent ${spent} / ${budget}
          </span>
        )}
        <Link href="/quotes" className="ml-auto font-mono text-[10px] text-white/35 hover:text-white/60">
          full queue →
        </Link>
      </div>
      {err && <p className="font-mono text-[11px] text-red-400">{err}</p>}

      {/* Progress — the bar, then the lanes as a step list. */}
      {run && (
        <div className="space-y-2.5 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-white/30">
              {running ? "Discovering" : abandoned ? "Run abandoned" : run.status === "complete" ? "Run complete" : `Run ${run.status}`}
            </span>
            <span className="font-mono text-[10px] text-white/35">
              {running && elapsedMs != null ? (
                <>
                  {formatDuration(elapsedMs)} elapsed
                  <span className="text-white/25"> · </span>
                  {leftMs < 8000 ? "finishing up" : `~${formatDuration(leftMs)} left`}
                </>
              ) : abandoned ? (
                "stopped before finishing — start a new one"
              ) : totalMs && totalMs > 0 ? (
                `finished in ${formatDuration(totalMs)}`
              ) : null}
            </span>
          </div>

          <div className="h-1 overflow-hidden rounded-full bg-white/[0.07]">
            <div
              className={`h-full rounded-full transition-[width] duration-500 ease-out ${
                running ? "bg-eco-lightblue" : abandoned ? "bg-white/20" : run.status === "complete" ? "bg-emerald-400/70" : "bg-amber-300/70"
              }`}
              style={{ width: `${Math.max(2, Math.round(fraction * 100))}%` }}
            />
          </div>

          <div className="space-y-1.5">
            {LANES.map((l) => {
              const st = run.laneStatus?.[l];
              const s = run.stats?.[l];
              const isCurrent = progress?.lane === l;
              const laneMs = s?.ms;
              const laneEta = eta?.[l] ?? DEFAULT_LANE_MS[l];
              return (
                <div key={l} className="flex items-start gap-2" title={LANE_NOTE[l]}>
                  <LaneMark status={abandoned && st === "running" ? "partial" : st} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={`truncate text-[11px] ${st === "queued" || !st ? "text-white/35" : "text-white/70"}`}>
                        {LANE_LABEL[l]}
                      </span>
                      <span className={`shrink-0 font-mono text-[10px] ${statusTone(abandoned && st === "running" ? "partial" : st)}`}>
                        {abandoned && st === "running"
                          ? "stopped"
                          : laneIsDone(st) && laneMs
                            ? `${st} · ${formatDuration(laneMs)}`
                            : (st ?? "queued")}
                      </span>
                    </div>

                    {/* What this lane is doing right now, or what it found. */}
                    <div className="font-mono text-[10px] leading-relaxed text-white/30">
                      {isCurrent ? (
                        <>
                          {stepLabel(l, progress!.step)}
                          {progress!.total ? ` ${Math.min(progress!.done ?? 0, progress!.total)}/${progress!.total}` : ""}
                          {progress!.note ? <span className="text-white/20"> — {progress!.note}</span> : null}
                        </>
                      ) : s ? (
                        `${s.docs ?? 0} sources · ${s.candidates ?? 0} candidates${s.verifyFailed ? ` · ${s.verifyFailed} failed verify` : ""}`
                      ) : st === "running" ? (
                        abandoned ? "stopped mid-lane" : "starting…"
                      ) : (
                        `queued · ~${formatDuration(laneEta)}`
                      )}
                    </div>

                    {/* Per-lane bar. Only the lane in flight gets one — a row of
                        three bars would compete with the overall one above. */}
                    {isCurrent && (
                      <div className="mt-1 h-[2px] overflow-hidden rounded-full bg-white/[0.06]">
                        <div
                          className="h-full rounded-full bg-eco-lightblue/60 transition-[width] duration-500 ease-out"
                          style={{
                            width: `${Math.max(3, Math.round(
                              Math.min(0.97, Math.max(
                                laneFraction(l, progress),
                                laneElapsedMs != null ? Math.min(0.95, laneElapsedMs / laneEta) : 0,
                              )) * 100,
                            ))}%`,
                          }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* The plan, so the wait has a shape even before a lane reports in. */}
          {running && (
            <p className="font-mono text-[10px] leading-relaxed text-white/20">
              {LANE_STEPS[progress?.lane ?? "x"].map((s) => s.label).join(" → ")}
            </p>
          )}
        </div>
      )}

      {run?.errors?.length ? (
        <details className="rounded-xl border border-amber-300/20 bg-amber-300/[0.04] px-3 py-2">
          <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wider text-amber-300/70">
            {run.errors.length} lane warning{run.errors.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1.5 space-y-0.5">
            {run.errors.slice(0, 10).map((e, i) => (
              <li key={i} className="font-mono text-[10px] leading-relaxed text-white/40">{e}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* Queue */}
      {queue.length > 0 ? (
        <div className="space-y-2">
          {queue.slice(0, 6).map((q) => (
            <QuoteCard key={q.id} q={q} onReviewed={(id) => setQueue((cur) => cur.filter((c) => c.id !== id))} />
          ))}
          {queue.length > 6 && (
            <Link href="/quotes" className="block text-center font-mono text-[11px] text-eco-lightblue/80 hover:text-eco-lightblue">
              {queue.length - 6} more in the full queue →
            </Link>
          )}
        </div>
      ) : (
        <p className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-4 text-center text-xs text-white/35">
          {run ? "No candidates in the queue. Run a discovery pass or widen the lookback." : "Nothing discovered yet — run a pass to fill the queue."}
        </p>
      )}
    </div>
  );
}
