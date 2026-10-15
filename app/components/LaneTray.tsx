"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PendingLane } from "@/lib/stats";

// The review tray for auto-detected lanes (Migration 019).
//
// The lanes in here are already LIVE — they appear in their pillar's lane list,
// their posts are tagged into them, and the tray is not a gate. That is the
// deliberate answer to "can this be automated instead of me updating it by
// hand": a chain we have already announced should not wait on a click to get a
// clock. What the tray buys is the other half — a place where a lane the
// detector got wrong is visible and one click from gone, instead of quietly
// accumulating.
//
// Everything a bad lane looks like is on the row: the post that produced it,
// what it matches on, and how many posts it actually caught. A lane matching
// zero posts is inert; a lane matching a suspiciously round number of them is
// usually an ordinary English word that slipped the term filter.

const KIND_LABEL: Record<PendingLane["kind"], string> = {
  chain: "Chain",
  product: "Product",
  partner: "Partner",
};

export default function LaneTray({ lanes }: { lanes: PendingLane[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [merging, setMerging] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!lanes.length) return null;

  async function act(lane: PendingLane, action: string, value?: string) {
    const key = `${lane.kind}|${lane.id}`;
    setBusy(key);
    setError(null);
    try {
      const res = await fetch("/api/lanes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: lane.kind, id: lane.id, action, value }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "failed");
      setRenaming(null);
      setMerging(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-6 rounded-2xl border border-amber-300/25 bg-amber-300/[0.04] p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-amber-200/70">
          New lanes from the last sync
        </span>
        <span className="text-[11px] text-white/35">
          {lanes.length} lane{lanes.length === 1 ? "" : "s"} · already live and collecting posts — this is where you
          correct one
        </span>
      </div>

      {error && <p className="mt-2 text-xs text-red-300">{error}</p>}

      <div className="mt-3 space-y-2">
        {lanes.map((l) => {
          const key = `${l.kind}|${l.id}`;
          const pending = busy === key;
          return (
            <div key={key} className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-white/45">
                  {KIND_LABEL[l.kind]}
                </span>
                <span className="text-sm text-white/85">{l.label}</span>
                <span className="font-mono text-[10px] text-white/30">{l.id}</span>
                <span
                  className={`font-mono text-[10px] ${l.postCount === 0 ? "text-amber-300/80" : "text-white/35"}`}
                  title={
                    l.postCount === 0
                      ? "This lane matches no posts — it will show as 'never posted' forever until it gets a handle or term that catches something."
                      : "Posts currently tagged into this lane"
                  }
                >
                  {l.postCount} post{l.postCount === 1 ? "" : "s"}
                </span>
              </div>

              {l.why && <p className="mt-1.5 text-[11px] leading-relaxed text-white/50">{l.why}</p>}

              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                <span className="font-mono uppercase tracking-wider text-white/25">matches</span>
                {l.handles.map((h) => (
                  <span key={h} className="rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-white/55">
                    @{h}
                  </span>
                ))}
                {l.terms.map((t) => (
                  <span
                    key={t}
                    className="rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-white/40"
                    title="Text term — only matched on a post that also mentions Eco"
                  >
                    {t}
                  </span>
                ))}
                {!l.handles.length && !l.terms.length && <span className="text-amber-300/70">nothing — inert lane</span>}
              </div>

              {l.postUrl && (
                <a
                  href={l.postUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1.5 block truncate text-[11px] text-white/30 underline-offset-2 hover:text-white/60 hover:underline"
                >
                  from: {(l.postText ?? "").replace(/\s+/g, " ").slice(0, 120)}
                </a>
              )}

              {renaming === key ? (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <input
                    autoFocus
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && act(l, "rename", draftName)}
                    className="rounded-lg border border-white/15 bg-black/30 px-2 py-1 text-xs text-white/85 outline-none focus:border-white/35"
                    placeholder={l.label}
                  />
                  <Btn onClick={() => act(l, "rename", draftName)} disabled={pending || !draftName.trim()}>
                    Save
                  </Btn>
                  <Btn onClick={() => setRenaming(null)} disabled={pending}>
                    Cancel
                  </Btn>
                </div>
              ) : merging === key ? (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <select
                    autoFocus
                    defaultValue=""
                    onChange={(e) => e.target.value && act(l, "merge", e.target.value)}
                    className="rounded-lg border border-white/15 bg-black/30 px-2 py-1 text-xs text-white/85 outline-none focus:border-white/35"
                  >
                    <option value="" disabled>
                      Merge into…
                    </option>
                    {l.mergeTargets.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <Btn onClick={() => setMerging(null)} disabled={pending}>
                    Cancel
                  </Btn>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Btn onClick={() => act(l, "confirm")} disabled={pending} tone="good">
                    Keep
                  </Btn>
                  <Btn
                    onClick={() => {
                      setDraftName(l.label);
                      setRenaming(key);
                    }}
                    disabled={pending}
                  >
                    Rename
                  </Btn>
                  {l.mergeTargets.length > 0 && (
                    <Btn onClick={() => setMerging(key)} disabled={pending}>
                      Merge into…
                    </Btn>
                  )}
                  <Btn onClick={() => act(l, "dismiss")} disabled={pending} tone="warn">
                    Not a lane
                  </Btn>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Btn({
  children,
  onClick,
  disabled,
  tone = "mute",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "good" | "warn" | "mute";
}) {
  const tones = {
    good: "border-emerald-400/30 bg-emerald-400/[0.08] text-emerald-200/90 hover:bg-emerald-400/15",
    warn: "border-red-400/25 bg-red-400/[0.06] text-red-300/80 hover:bg-red-400/12",
    mute: "border-white/12 bg-white/[0.03] text-white/60 hover:bg-white/[0.07]",
  } as const;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border px-2 py-1 text-[11px] transition disabled:opacity-40 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}
