"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

// One unified action surface per recommendation. Replaces the old
// CopyGenerator + standalone chain-dropdown + always-on Mark-as-used. Robert's
// redesign:
//   - You pick WHAT to draft from (any chain, any TL article, any discovered
//     piece) — not just the single suggestion.
//   - Draft copy first; only after you draft AND pick an option does "Mark as
//     used" appear, bound to that exact target + angle.
//   - Broad-educational never reshares, so instead of "post this again" it
//     shows what worked + a Discover button that finds fresh source material.

export interface Target {
  key: string;
  label: string;
  sublabel?: string;
  chain?: string | null;
  basePostText?: string | null;
  angle?: string | null;
  href?: string | null;
}

export interface BroadEdData {
  byType: { mediaType: string; count: number; medianImpr: number | null }[];
  topEntities: { entity: string; label: string; count: number; medianImpr: number | null }[];
  topAngles: { id: string; url: string; title: string; impressions: number | null; mediaType: string }[];
}

interface CopyOption {
  angle: string;
  text: string;
  rationale: string;
}

function compact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1000) return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  return String(n);
}

export function RecActions({
  template,
  score,
  mode,
  targets = [],
  broad,
  recDrivenCount = 0,
  recDrivenVsBaseline = null,
}: {
  template: string;
  score: number;
  mode: "chains" | "articles" | "broad" | "generic";
  targets?: Target[];
  broad?: BroadEdData;
  recDrivenCount?: number;
  recDrivenVsBaseline?: number | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  // Discover (broad mode) — fetched candidates become extra targets.
  const [discovered, setDiscovered] = useState<Target[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoverErr, setDiscoverErr] = useState<string | null>(null);
  const [discoverWarn, setDiscoverWarn] = useState<string[]>([]);

  // Draft state, keyed by target.key.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [optionsByKey, setOptionsByKey] = useState<Record<string, CopyOption[]>>({});
  const [errByKey, setErrByKey] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<{ key: string; idx: number } | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  // Mark-as-used state.
  const [marking, setMarking] = useState(false);
  const [markedKey, setMarkedKey] = useState<string | null>(null);

  const allTargets = mode === "broad" ? discovered : targets;

  async function draft(t: Target) {
    setActiveKey(t.key);
    setSelected(null);
    if (optionsByKey[t.key]) return; // already drafted this target
    setLoadingKey(t.key);
    setErrByKey((e) => ({ ...e, [t.key]: "" }));
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ template, chain: t.chain ?? null, angle: t.angle ?? null, basePostText: t.basePostText ?? null }),
      });
      const data = await res.json();
      if (data.ok) setOptionsByKey((o) => ({ ...o, [t.key]: data.options ?? [] }));
      else setErrByKey((e) => ({ ...e, [t.key]: data.error || "Failed" }));
    } catch (e) {
      setErrByKey((err) => ({ ...err, [t.key]: e instanceof Error ? e.message : "Failed" }));
    } finally {
      setLoadingKey(null);
    }
  }

  async function copy(text: string, idx: number) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  async function markUsed(t: Target, opt: CopyOption) {
    setMarking(true);
    try {
      const res = await fetch("/api/use", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          template,
          chain: t.chain ?? null,
          angle: [t.label, opt.angle].filter(Boolean).join(" · ").slice(0, 500),
          scoreAtUse: score,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setMarkedKey(t.key);
        startTransition(() => router.refresh());
      }
    } finally {
      setMarking(false);
    }
  }

  async function runDiscover() {
    setDiscovering(true);
    setDiscoverErr(null);
    setDiscoverWarn([]);
    try {
      const res = await fetch("/api/discover", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setDiscovered(
          (data.items ?? []).map((it: Record<string, unknown>, i: number) => ({
            key: `disc-${i}`,
            label: String(it.headline ?? ""),
            sublabel: [it.keyStat, it.contentType, it.icp].filter(Boolean).join(" · "),
            chain: null,
            angle: String(it.headline ?? ""),
            basePostText: [it.summary, it.source && (it.source as { url?: string }).url ? `Source: ${(it.source as { url: string }).url}` : ""]
              .filter(Boolean)
              .join("\n"),
            href: (it.source as { url?: string } | undefined)?.url ?? null,
          })),
        );
        setDiscoverWarn(data.warnings ?? []);
      } else setDiscoverErr(data.error || "Discover failed");
    } catch (e) {
      setDiscoverErr(e instanceof Error ? e.message : "Discover failed");
    } finally {
      setDiscovering(false);
    }
  }

  return (
    <div className="mt-3 border-t border-white/[0.07] pt-3">
      {/* rec-driven signal */}
      <div className="mb-2 text-xs text-white/40">
        {recDrivenCount > 0 ? (
          <span>
            {recDrivenCount} post{recDrivenCount === 1 ? "" : "s"} run from this
            {recDrivenVsBaseline != null && (
              <span className={recDrivenVsBaseline >= 1 ? "text-emerald-300/80" : "text-amber-300/80"}>
                {" "}· {recDrivenVsBaseline >= 1 ? "beating" : "under"} baseline ({(recDrivenVsBaseline * 100).toFixed(0)}%)
              </span>
            )}
          </span>
        ) : (
          <span className="text-white/30">
            {mode === "chains" && "Pick a chain angle and draft copy for it."}
            {mode === "articles" && "Pick an article and draft copy for it."}
            {mode === "broad" && "Discover fresh source material, then draft from it. (We never reshare a piece.)"}
            {mode === "generic" && "Draft starting copy for this pillar."}
          </span>
        )}
      </div>

      {/* Broad-educational: what worked, then Discover. */}
      {mode === "broad" && broad && <WhatWorked broad={broad} />}
      {mode === "broad" && (
        <div className="mb-3">
          <button
            onClick={runDiscover}
            disabled={discovering}
            className="rounded-full bg-eco-blue px-3.5 py-1.5 text-xs font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {discovering ? "Discovering…" : discovered.length ? "Discover more" : "Discover fresh sources"}
          </button>
          {discovering && <span className="ml-2 text-xs text-white/40">Searching the web + X for recent, unused angles…</span>}
          {discoverErr && <span className="ml-2 font-mono text-[11px] text-red-400">{discoverErr}</span>}
          {discoverWarn.map((w, i) => (
            <div key={i} className="mt-1 font-mono text-[10px] text-amber-300/70">{w}</div>
          ))}
        </div>
      )}

      {/* Targets */}
      <div className="space-y-1.5">
        {allTargets.map((t) => {
          const opts = optionsByKey[t.key];
          const isActive = activeKey === t.key;
          const isLoading = loadingKey === t.key;
          const err = errByKey[t.key];
          return (
            <div key={t.key} className="rounded-xl border border-white/10 bg-white/[0.02]">
              <div className="flex items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {t.href ? (
                      <a href={t.href} target="_blank" rel="noreferrer" className="truncate text-sm font-medium text-white/85 hover:text-eco-lightblue">
                        {t.label}
                      </a>
                    ) : (
                      <span className="truncate text-sm font-medium text-white/85">{t.label}</span>
                    )}
                  </div>
                  {t.sublabel && <div className="mt-0.5 truncate font-mono text-[10px] text-white/35">{t.sublabel}</div>}
                </div>
                <button
                  onClick={() => draft(t)}
                  disabled={isLoading}
                  className="flex-none rounded-full border border-white/15 px-3 py-1 text-xs font-medium text-white/70 transition hover:border-eco-lightblue hover:text-eco-lightblue disabled:opacity-50"
                >
                  {isLoading ? "Drafting…" : opts ? "Redraft" : "Draft copy"}
                </button>
              </div>

              {isActive && (opts || err) && (
                <div className="space-y-2 border-t border-white/[0.06] px-3 pb-3 pt-2">
                  {err && <p className="font-mono text-[11px] text-red-400">{err}</p>}
                  {opts?.map((o, i) => {
                    const isSel = selected?.key === t.key && selected.idx === i;
                    return (
                      <div
                        key={i}
                        onClick={() => setSelected({ key: t.key, idx: i })}
                        className={`cursor-pointer rounded-lg border p-2.5 transition ${
                          isSel ? "border-eco-lightblue/50 bg-eco-lightblue/[0.06]" : "border-white/10 bg-white/[0.02] hover:border-white/25"
                        }`}
                      >
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-eco-lightblue/80">
                            <span className={`inline-block h-2.5 w-2.5 rounded-full border ${isSel ? "border-eco-lightblue bg-eco-lightblue" : "border-white/30"}`} />
                            {o.angle}
                          </span>
                          <button
                            onClick={(e) => { e.stopPropagation(); copy(o.text, i); }}
                            className="rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-white/60 transition hover:border-white/30 hover:text-white/90"
                          >
                            {copiedIdx === i ? "Copied ✓" : "Copy"}
                          </button>
                        </div>
                        <p className="whitespace-pre-wrap text-sm text-white/85">{o.text}</p>
                        {o.rationale && <p className="mt-1 text-[11px] italic text-white/40">{o.rationale}</p>}
                      </div>
                    );
                  })}

                  {/* Mark as used — only once an option is selected for this target. */}
                  {opts && selected?.key === t.key && (
                    markedKey === t.key ? (
                      <span className="inline-block rounded-full bg-emerald-400/15 px-2.5 py-1 text-xs font-medium text-emerald-300">
                        Marked as used ✓ — it&apos;ll show in History
                      </span>
                    ) : (
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          onClick={() => markUsed(t, opts[selected.idx])}
                          disabled={marking}
                          className="rounded-full bg-eco-blue px-3.5 py-1.5 text-xs font-medium text-white transition hover:brightness-110 disabled:opacity-50"
                        >
                          {marking ? "Marking…" : "Mark as used"}
                        </button>
                        <span className="text-[11px] text-white/35">once you post this draft</span>
                      </div>
                    )
                  )}
                  {opts && opts.length > 0 && <p className="text-[10px] text-white/30">Starting points — take them to 90/10 before posting.</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WhatWorked({ broad }: { broad: BroadEdData }) {
  if (!broad.byType.length && !broad.topEntities.length) return null;
  return (
    <div className="mb-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-white/30">What&apos;s worked here — by approach</div>
      {broad.byType.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {broad.byType.map((t) => (
            <span key={t.mediaType} className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 text-xs text-white/70">
              {mediaLabel(t.mediaType)} <span className="font-mono text-[10px] text-white/40">· {compact(t.medianImpr)} med · {t.count}×</span>
            </span>
          ))}
        </div>
      )}
      {broad.topEntities.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-white/25">Mentions that landed</span>
          {broad.topEntities.map((e) => (
            <span key={e.entity} className="rounded-lg border border-white/[0.08] px-2 py-0.5 text-xs text-white/60">
              {e.label} <span className="font-mono text-[10px] text-white/35">{compact(e.medianImpr)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function mediaLabel(t: string): string {
  switch (t) {
    case "video": return "Video";
    case "animated_gif": return "GIF";
    case "photo": return "Image";
    case "link-card": return "Article/link";
    case "text": return "Text";
    default: return t;
  }
}
