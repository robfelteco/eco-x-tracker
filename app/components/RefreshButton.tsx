"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useAction, ActionProgress } from "./useAction";

// Manual "Refresh now" — POSTs /api/sync (session-authed), then refreshes the
// server components so new rows/snapshots show without a full reload.
export function RefreshButton({ backfill = false }: { backfill?: boolean }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  const act = useAction("sync");

  async function run() {
    setMsg(null);
    try {
      const data = await act.run(async () => {
        const res = await fetch(`/api/sync${backfill ? "?backfill=1" : ""}`, { method: "POST" });
        return { ...(await res.json()), ok: res.ok };
      });
      setMsg(data.summary || data.error || (data.ok ? "Done" : "Failed"));
      start(() => router.refresh());
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    }
  }

  const cls = backfill
    ? "rounded-full border border-white/10 px-3 py-2 text-xs font-medium text-white/60 transition hover:border-eco-lightblue hover:text-eco-lightblue disabled:cursor-not-allowed disabled:opacity-50"
    : "rounded-full bg-eco-blue px-5 py-2.5 text-sm font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50";

  const busy = pending || act.pending;

  return (
    <div>
      <div className="flex items-center gap-3">
        <button onClick={run} disabled={busy} className={cls}>
          {busy ? "Refreshing…" : backfill ? "Backfill history" : "Refresh now"}
        </button>
        {msg && <span className="font-mono text-[11px] text-white/45">{msg}</span>}
      </div>
      <ActionProgress state={act.state} className="max-w-sm" />
    </div>
  );
}
