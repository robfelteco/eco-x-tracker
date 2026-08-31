"use client";

import { useState } from "react";
import { useAction, ActionProgress } from "./useAction";

// One candidate row in the quote review queue (spec §11).
//
// The bar this has to clear: a reviewer should be able to approve without
// leaving the app. So the card carries the verbatim quote, who said it and
// where, a deep link that lands on the moment, and enough surrounding context
// to rule out out-of-context quoting in one glance. If a reviewer has to go
// verify the quote manually, the run failed.

export interface QuoteCandidate {
  id: number;
  quoteText: string;
  speakerName: string;
  speakerTitle: string | null;
  orgName: string | null;
  orgTier: number | null;
  handlesVerifiedAt: string | null;
  saidAt: string | null;
  deepLink: string;
  contextBefore: string | null;
  contextAfter: string | null;
  topicTags: string[];
  verification: string;
  score: number | null;
  scoreBreakdown: Record<string, number> | null;
  pillarTag: string | null;
  disqualifiers: string[];
  status: string;
  sourceKind: string;
  sourceTitle: string | null;
}

export const REJECT_OPTIONS: { id: string; label: string }[] = [
  { id: "misattributed", label: "Misattributed" },
  { id: "out_of_context", label: "Out of context" },
  { id: "off_narrative", label: "Off-narrative" },
  { id: "too_long", label: "Too long" },
  { id: "competitor", label: "Competitor" },
  { id: "already_used", label: "Already used" },
  { id: "weak_speaker", label: "Weak speaker" },
];

const SOURCE_ICON: Record<string, string> = {
  x_post: "𝕏",
  youtube: "▶",
  article: "¶",
  report: "▤",
};

const PILLAR_LABEL: Record<string, string> = {
  A: "A · inevitability",
  B: "B · primary + secondary markets",
  C: "C · five-layer stack",
  D: "D · defensibility",
};

function tierBadge(tier: number | null) {
  if (tier == null) return { text: "unrostered", cls: "bg-white/[0.06] text-white/45" };
  if (tier === 1) return { text: "Tier 1", cls: "bg-emerald-400/15 text-emerald-300" };
  if (tier === 2) return { text: "Tier 2", cls: "bg-eco-lightblue/15 text-eco-lightblue" };
  return { text: "Tier 3", cls: "bg-white/[0.08] text-white/55" };
}

export function QuoteCard({ q, onReviewed }: { q: QuoteCandidate; onReviewed: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const act = useAction("review");
  const [done, setDone] = useState<string | null>(null);
  const tier = tierBadge(q.orgTier);
  const words = q.quoteText.trim().split(/\s+/).length;

  async function review(action: "approve" | "reject", reason?: string) {
    setBusy(true);
    try {
      const data = await act.run(async () => {
        const res = await fetch("/api/quotes/review", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: q.id, action, reason }),
        });
        return res.json();
      });
      if (data.ok) {
        setDone(action === "approve" ? "Approved" : "Rejected");
        onReviewed(q.id);
      }
    } finally {
      setBusy(false);
      setRejecting(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-xs text-white/40">
        {done} — <span className="text-white/60">&ldquo;{q.quoteText.slice(0, 70)}…&rdquo;</span>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug text-white/90">&ldquo;{q.quoteText}&rdquo;</p>

          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="font-medium text-white/80">{q.speakerName}</span>
            {q.speakerTitle && <span className="text-white/45">{q.speakerTitle}</span>}
            {q.orgName && <span className="text-white/45">· {q.orgName}</span>}
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${tier.cls}`}>{tier.text}</span>
            {!q.handlesVerifiedAt && (
              <span
                className="rounded-full bg-amber-400/15 px-1.5 py-0.5 text-[10px] text-amber-300"
                title="This speaker's title has not been verified by a human yet. Confirm before the card ships."
              >
                unverified title
              </span>
            )}
            {q.verification === "fuzzy" && (
              <span
                className="rounded-full bg-amber-400/15 px-1.5 py-0.5 text-[10px] text-amber-300"
                title="Matched the source at 95%+ but not exactly. Listen back before approving — it cannot be auto-approved."
              >
                fuzzy — listen back
              </span>
            )}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-white/30">
            <span title={q.sourceKind}>{SOURCE_ICON[q.sourceKind] ?? "·"} {q.sourceKind.replace("_", " ")}</span>
            {q.saidAt && <span>· {new Date(q.saidAt).toISOString().slice(0, 10)}</span>}
            <span>· {words} words</span>
            {q.pillarTag && <span className="text-eco-lightblue/70">· pillar {PILLAR_LABEL[q.pillarTag] ?? q.pillarTag}</span>}
            {q.topicTags.slice(0, 3).map((t) => (
              <span key={t}>· {t}</span>
            ))}
          </div>

          {q.disqualifiers.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {q.disqualifiers.map((d) => (
                <span key={d} className="rounded bg-red-400/15 px-1.5 py-0.5 font-mono text-[10px] text-red-300">
                  {d.replace(/_/g, " ")}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-none flex-col items-end gap-1.5">
          <div
            className="flex h-11 w-11 flex-col items-center justify-center rounded-lg border border-white/15 bg-white/[0.04]"
            title={
              q.scoreBreakdown
                ? Object.entries(q.scoreBreakdown).map(([k, v]) => `${k}: ${v}`).join("  ·  ")
                : "no breakdown"
            }
          >
            <span className="text-sm font-semibold tabular-nums text-white/85">{q.score ?? "—"}</span>
            <span className="font-mono text-[8px] uppercase tracking-wider text-white/35">score</span>
          </div>
          <a
            href={q.deepLink}
            target="_blank"
            rel="noreferrer"
            className="whitespace-nowrap font-mono text-[10px] text-eco-lightblue/80 hover:text-eco-lightblue"
          >
            open source ↗
          </a>
        </div>
      </div>

      {(q.contextBefore || q.contextAfter) && (
        <button
          onClick={() => setOpen((o) => !o)}
          className="mt-2 font-mono text-[10px] uppercase tracking-wider text-white/30 hover:text-white/50"
        >
          {open ? "Hide context" : "Show surrounding context"}
        </button>
      )}
      {open && (
        <div className="mt-1.5 rounded-lg border border-white/[0.07] bg-black/20 p-2 text-[11px] leading-relaxed text-white/45">
          {q.contextBefore && <span>…{q.contextBefore} </span>}
          <span className="text-white/85">&ldquo;{q.quoteText}&rdquo;</span>
          {q.contextAfter && <span> {q.contextAfter}…</span>}
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          onClick={() => review("approve")}
          disabled={busy}
          className="rounded-full bg-eco-blue px-3 py-1 text-xs font-medium text-white transition hover:brightness-110 disabled:opacity-50"
        >
          Approve
        </button>
        {rejecting ? (
          <div className="flex flex-wrap items-center gap-1">
            {REJECT_OPTIONS.map((r) => (
              <button
                key={r.id}
                onClick={() => review("reject", r.id)}
                disabled={busy}
                className="rounded-md border border-white/12 px-1.5 py-0.5 text-[11px] text-white/60 transition hover:border-red-400/40 hover:text-red-300 disabled:opacity-50"
              >
                {r.label}
              </button>
            ))}
            <button onClick={() => setRejecting(false)} className="px-1 text-[11px] text-white/30 hover:text-white/60">
              cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setRejecting(true)}
            disabled={busy}
            className="rounded-full border border-white/15 px-3 py-1 text-xs font-medium text-white/60 transition hover:border-white/30 hover:text-white/85 disabled:opacity-50"
          >
            Reject with reason
          </button>
        )}
      </div>
      <ActionProgress state={act.state} className="max-w-[220px]" />
    </div>
  );
}
