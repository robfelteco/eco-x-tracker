"use client";

import { useState } from "react";
import { QuoteCard, type QuoteCandidate } from "./QuoteCard";

// Client wrapper so a reviewed candidate leaves the list immediately instead of
// waiting on a round-trip. Sorted by score desc server-side (spec §11).
export function QuoteQueue({ initial }: { initial: QuoteCandidate[] }) {
  const [items, setItems] = useState(initial);
  const [hideDisqualified, setHideDisqualified] = useState(true);

  const shown = hideDisqualified ? items.filter((q) => q.disqualifiers.length === 0) : items;
  const hidden = items.length - shown.length;

  if (!items.length) {
    return (
      <p className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-6 text-center text-sm text-white/35">
        Queue is empty. Run a discovery pass from the Quote Card pillar on Prioritize.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {hidden > 0 && (
        <button
          onClick={() => setHideDisqualified((h) => !h)}
          className="font-mono text-[10px] uppercase tracking-wider text-white/30 hover:text-white/55"
        >
          {hideDisqualified ? `Show ${hidden} auto-disqualified` : "Hide auto-disqualified"}
        </button>
      )}
      {shown.map((q) => (
        <QuoteCard key={q.id} q={q} onReviewed={(id) => setItems((cur) => cur.filter((c) => c.id !== id))} />
      ))}
    </div>
  );
}
