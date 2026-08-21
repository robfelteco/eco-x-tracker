"use client";

import { useState } from "react";

interface CopyOption {
  angle: string;
  text: string;
  rationale: string;
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

  async function generate() {
    setOpen(true);
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ template, chain, basePostText }),
      });
      const data = await res.json();
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

      {open && (
        <div className="mt-3 space-y-2">
          {err && <p className="font-mono text-[11px] text-red-400">{err}</p>}
          {!err && loading && options.length === 0 && (
            <p className="text-xs text-white/40">Drafting 2–3 on-brand starting points…</p>
          )}
          {options.map((o, i) => (
            <div key={i} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] uppercase tracking-wider text-eco-lightblue/80">{o.angle}</span>
                <button
                  onClick={() => copy(o.text, i)}
                  className="rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-white/60 transition hover:border-white/30 hover:text-white/90"
                >
                  {copied === i ? "Copied ✓" : "Copy"}
                </button>
              </div>
              <p className="whitespace-pre-wrap text-sm text-white/85">{o.text}</p>
              {o.rationale && <p className="mt-1.5 text-[11px] italic text-white/40">{o.rationale}</p>}
            </div>
          ))}
          {!loading && !err && options.length > 0 && (
            <p className="text-[10px] text-white/30">Starting points — take them to 90/10 before posting.</p>
          )}
        </div>
      )}
    </div>
  );
}
