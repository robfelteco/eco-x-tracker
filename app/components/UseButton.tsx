"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export interface ChainOption {
  chain: string;
  label: string;
}

// "Mark as used" — records that the operator acted on this recommendation so the
// next sync can attribute the resulting @eco post back to it (the recursion loop
// Jay wants: credit only what the tool actually drove). Optional chain picker
// defaults to the pillar's best untapped angle. Kept tiny so it fits the "do 20
// reps" flow without slowing it down.
export function UseButton({
  template,
  score,
  chains = [],
  defaultChain = null,
  suggestedPostId = null,
}: {
  template: string;
  score: number;
  chains?: ChainOption[];
  defaultChain?: string | null;
  suggestedPostId?: string | null;
}) {
  const [pending, start] = useTransition();
  const [chain, setChain] = useState<string>(defaultChain ?? "");
  const [done, setDone] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  async function mark() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/use", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          template,
          chain: chain || null,
          scoreAtUse: score,
          suggestedPostId,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setDone(data.id);
        start(() => router.refresh());
      } else {
        setErr(data.error || "Failed");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (done == null) return;
    setBusy(true);
    try {
      await fetch("/api/use", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: done }),
      });
      setDone(null);
      start(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  if (done != null) {
    return (
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-emerald-400/15 px-2.5 py-1 text-xs font-medium text-emerald-300">
          Marked as used ✓
        </span>
        <button onClick={undo} disabled={busy} className="text-xs text-white/40 underline hover:text-white/70">
          undo
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {chains.length > 0 && (
        <select
          value={chain}
          onChange={(e) => setChain(e.target.value)}
          className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 text-xs text-white/70"
          aria-label="Chain angle"
        >
          <option value="">No specific chain</option>
          {chains.map((c) => (
            <option key={c.chain} value={c.chain}>
              {c.label}
            </option>
          ))}
        </select>
      )}
      <button
        onClick={mark}
        disabled={busy || pending}
        className="rounded-full bg-eco-blue px-3.5 py-1.5 text-xs font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Marking…" : "Mark as used"}
      </button>
      {err && <span className="font-mono text-[10px] text-red-400">{err}</span>}
    </div>
  );
}
