"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { QuoteCard, type QuoteCandidate } from "./QuoteCard";

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

const LANES = ["x", "youtube", "web"] as const;
type Lane = (typeof LANES)[number];

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
  laneStatus: Record<string, string>;
  spendCents: number;
  budgetCents: number;
  lookbackDays: number;
  stats: Record<string, { docs?: number; candidates?: number; verifyFailed?: number }>;
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

export function QuoteDiscovery() {
  const [run, setRun] = useState<RunState | null>(null);
  const [queue, setQueue] = useState<QuoteCandidate[]>([]);
  const [counts, setCounts] = useState({ candidate: 0, approved: 0, rejected: 0 });
  const [roster, setRoster] = useState<RosterHealth | null>(null);
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lookbackDays, setLookbackDays] = useState(365);
  const [budgetUsd, setBudgetUsd] = useState(5);
  const driving = useRef(false);

  const refresh = useCallback(async (runId?: number) => {
    try {
      const res = await fetch(`/api/quotes/status${runId ? `?runId=${runId}` : ""}`);
      const data = await res.json();
      if (!data.ok) return;
      if (data.run) setRun(data.run);
      setQueue(data.queue ?? []);
      setCounts(data.counts ?? { candidate: 0, approved: 0, rejected: 0 });
      setRoster(data.roster ?? null);
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Drive the lanes sequentially. Each lane is its own request so a long Gemini
  // pass can't blow a serverless duration limit, and results land per lane
  // instead of all-or-nothing at the end.
  async function start() {
    if (driving.current) return;
    driving.current = true;
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
          await refresh(data.runId);
          return;
        }
        setErr(data.error || "Could not start a run");
        return;
      }
      const runId: number = data.runId;
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
    } finally {
      setStarting(false);
      driving.current = false;
    }
  }

  const spent = run ? (run.spendCents / 100).toFixed(2) : "0.00";
  const budget = run ? (run.budgetCents / 100).toFixed(2) : budgetUsd.toFixed(2);

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
          disabled={starting}
          className="rounded-full bg-eco-blue px-3.5 py-1.5 text-xs font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {starting ? "Discovering…" : "Find quotes"}
        </button>
        <label className="flex items-center gap-1 text-[11px] text-white/40">
          lookback
          <select
            value={lookbackDays}
            onChange={(e) => setLookbackDays(Number(e.target.value))}
            disabled={starting}
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
            disabled={starting}
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

      {/* Per-lane coverage */}
      {run && (
        <div className="grid gap-1.5 sm:grid-cols-3">
          {LANES.map((l) => {
            const st = run.laneStatus?.[l];
            const s = run.stats?.[l];
            return (
              <div key={l} className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-2.5 py-2" title={LANE_NOTE[l]}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[11px] text-white/65">{LANE_LABEL[l]}</span>
                  <span className={`font-mono text-[10px] ${statusTone(st)}`}>{st ?? "queued"}</span>
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-white/30">
                  {s ? `${s.docs ?? 0} sources · ${s.candidates ?? 0} candidates${s.verifyFailed ? ` · ${s.verifyFailed} failed verify` : ""}` : "—"}
                </div>
              </div>
            );
          })}
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
