"use client";

import { useState } from "react";
import { useAction, ActionProgress } from "./useAction";

interface CopyOption {
  angle: string;
  text: string;
  rationale: string;
  // lib/antiSlop.ts findings that survived the deterministic fixes and the
  // repair pass. Usually empty.
  slop?: { rule: string; severity: "hard" | "soft"; match: string; fix: string }[];
}

// "Draft starting copy" — calls /api/generate for one recommendation and shows
// 2-3 on-brand starting drafts, each copyable to clipboard. Deliberately a
// starting point, not a finished post (take it to 90/10). Collapsed until
// clicked so the board isn't spending Anthropic credits on page load.
export function CopyGenerator({
  template,
  chain = null,
  basePostText = null,
}: {
  template: string;
  chain?: string | null;
  basePostText?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<CopyOption[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const act = useAction("generate");

  async function generate() {
    setOpen(true);
    setLoading(true);
    setErr(null);
    try {
      const data = await act.run(async () => {
        const res = await fetch("/api/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ template, chain, basePostText }),
        });
        return res.json();
      });
      if (data.ok) setOptions(data.options ?? []);
      else setErr(data.error || "Failed");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  async function copy(text: string, i: number) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(i);
      setTimeout(() => setCopied((c) => (c === i ? null : c)), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  return (
    <div>
      <button
        onClick={generate}
        disabled={loading}
        className="rounded-full border border-white/15 px-3.5 py-1.5 text-xs font-medium text-white/70 transition hover:border-eco-lightblue hover:text-eco-lightblue disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? "Drafting…" : options.length ? "Redraft copy" : "Draft starting copy"}
      </button>

      <ActionProgress state={act.state} className="max-w-md" />

      {open && (
        <div className="mt-3 space-y-2">
          {err && <p className="font-mono text-[11px] text-red-400">{err}</p>}

          {options.map((o, i) => (
            <div key={i} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-eco-lightblue/80">
                  <span className="truncate">{o.angle}</span>
                  <span className="flex-none rounded-full bg-white/[0.06] px-1.5 py-0.5 tabular-nums text-white/45">
                    {o.text.length < 280 ? "tight" : o.text.length < 900 ? "mid" : "long"} {o.text.length}
                  </span>
                </span>
                <button
                  onClick={() => copy(o.text, i)}
                  className="rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-white/60 transition hover:border-white/30 hover:text-white/90"
                >
                  {copied === i ? "Copied ✓" : "Copy"}
                </button>
              </div>
              <p className="whitespace-pre-wrap text-sm text-white/85">{o.text}</p>
              {o.rationale && <p className="mt-1.5 text-[11px] italic text-white/40">{o.rationale}</p>}
              {!!o.slop?.length && (
                <div className="mt-2 space-y-1 border-t border-white/[0.06] pt-1.5">
                  {o.slop.map((f, j) => (
                    <div key={j} className="flex items-baseline gap-1.5 text-[10.5px] leading-snug">
                      <span
                        className={`flex-none rounded px-1 py-px font-mono text-[9px] uppercase tracking-wider ${
                          f.severity === "hard" ? "bg-red-400/15 text-red-300" : "bg-amber-400/12 text-amber-300/80"
                        }`}
                      >
                        {f.rule}
                      </span>
                      <span className="min-w-0 text-white/45">
                        <span className="text-white/70">&ldquo;{f.match}&rdquo;</span> {f.fix}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {!loading && !err && options.length > 0 && (
            <p className="text-[10px] text-white/30">Starting points, take them to 90/10 before posting. One post each, never a thread.</p>
          )}
        </div>
      )}
    </div>
  );
}
