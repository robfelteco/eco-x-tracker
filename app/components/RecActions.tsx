"use client";

import { useState, useTransition } from "react";
import { NestedDisclosure } from "@/app/components/Collapse";
import { useRouter } from "next/navigation";
import { QuoteDiscovery } from "./QuoteDiscovery";

// One unified action surface per recommendation.
//
//   - You pick WHAT to draft from (a chain, a product, an article, a discovered
//     piece) — not just the single suggestion.
//   - Draft copy first; only after you draft AND pick an option does "Mark as
//     used" appear, bound to that exact target + angle.
//   - The mode comes from the pillar's declared draftMode, so Quote Card and
//     Product Posts no longer inherit chain angles they have no business having.
//   - Product Posts is two-level: pick the product, then the piece behind it.
//     Shapes ride along so you can see which angle that product has gone cold on.

export type DraftMode = "chains" | "products" | "articles" | "discovery" | "docs" | "videos" | "generic";

export interface ShapeUse {
  shape: string;
  label: string;
  count: number;
  daysSince: number | null;
  medianImpr: number | null;
}

export interface Target {
  key: string;
  label: string;
  sublabel?: string;
  chain?: string | null;
  product?: string | null;
  articleId?: number | null;
  docPageId?: number | null;
  videoId?: number | null;
  basePostText?: string | null;
  // Small coloured chip on the row — "Hero", "Never posted", "Has file".
  badges?: { label: string; tone: "good" | "warn" | "mute"; title?: string }[];
  // Clip thumbnail. A wall of video titles is unreadable; a contact sheet isn't.
  thumbUrl?: string | null;
  angle?: string | null;
  href?: string | null;
  useCount?: number;
  // Every post that has already used this article. Handed to the drafter with
  // an explicit "these angles are spent" instruction — the whole point of
  // grouping by article is that iteration N+1 should not repeat iterations 1..N.
  priorTexts?: string[];
}

// A collapsible lane on a two-level shelf. Product Posts pioneered the shape
// (pick the product, then the piece); Dev Doc and Short-Form Video reuse it
// because both have the same problem — 70+ docs pages and 300+ clips are
// unusable as one flat list, and both have an obvious first-level question
// ("which audience?", "which series?").
export interface LaneGroup {
  key: string;
  label: string;
  sublabel?: string;
  hint?: string;
  targets: Target[];
}

export interface ProductGroup {
  key: string;
  product: string;
  label: string;
  sublabel?: string;
  readiness: string;
  shapes: ShapeUse[];
  targets: Target[];
}

export interface DocsMeta {
  homeCount: number;
  homeMedian: number | null;
  deepCount: number;
  deepMedian: number | null;
  totalPages: number;
  neverUsed: number;
}

export interface VideosMeta {
  total: number;
  neverPosted: number;
  withFile: number;
  withTranscript: number;
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
  products = [],
  lanes = [],
  docsMeta,
  videosMeta,
  broad,
  recDrivenCount = 0,
  recDrivenVsBaseline = null,
}: {
  template: string;
  score: number;
  mode: DraftMode;
  targets?: Target[];
  products?: ProductGroup[];
  lanes?: LaneGroup[];
  docsMeta?: DocsMeta;
  videosMeta?: VideosMeta;
  broad?: BroadEdData;
  recDrivenCount?: number;
  recDrivenVsBaseline?: number | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  // Discover (broad-educational lane) — fetched candidates become extra targets.
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
  const [shapeByKey, setShapeByKey] = useState<Record<string, string>>({});

  // Which product accordion is open (products mode).
  const [openProduct, setOpenProduct] = useState<string | null>(products[0]?.key ?? null);
  // Which lane is open (docs / videos modes). Opens on the top-ranked lane,
  // which is the coldest audience or series — the answer to "what now".
  const [openLane, setOpenLane] = useState<string | null>(lanes[0]?.key ?? null);

  const [marking, setMarking] = useState(false);
  const [markedKey, setMarkedKey] = useState<string | null>(null);

  const isBroadDiscovery = mode === "discovery" && template === "broad_educational";
  const isQuoteDiscovery = mode === "discovery" && template === "quote_card";
  const flatTargets = isBroadDiscovery ? discovered : targets;

  async function draft(t: Target, shape?: string | null) {
    setActiveKey(t.key);
    setSelected(null);
    setLoadingKey(t.key);
    setErrByKey((e) => ({ ...e, [t.key]: "" }));
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          template,
          chain: t.chain ?? null,
          product: t.product ?? null,
          articleId: t.articleId ?? null,
          docPageId: t.docPageId ?? null,
          videoId: t.videoId ?? null,
          shape: shape ?? shapeByKey[t.key] ?? null,
          angle: t.angle ?? null,
          basePostText: t.basePostText ?? null,
          priorTexts: t.priorTexts ?? [],
        }),
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
          angle: [t.label, shapeByKey[t.key], opt.angle].filter(Boolean).join(" · ").slice(0, 500),
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

  function renderTarget(t: Target, shapePicker = false) {
    const opts = optionsByKey[t.key];
    const isActive = activeKey === t.key;
    const isLoading = loadingKey === t.key;
    const err = errByKey[t.key];
    return (
      <div key={t.key} className="rounded-xl border border-white/10 bg-white/[0.02]">
        <div className="flex items-center gap-2 px-3 py-2">
          {t.thumbUrl && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={t.thumbUrl}
              alt=""
              loading="lazy"
              className="h-10 w-16 flex-none rounded-md border border-white/10 object-cover"
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {t.href ? (
                <a href={t.href} target="_blank" rel="noreferrer" className="truncate text-sm font-medium text-white/85 hover:text-eco-lightblue">
                  {t.label}
                </a>
              ) : (
                <span className="truncate text-sm font-medium text-white/85">{t.label}</span>
              )}
              {t.useCount != null && t.useCount > 1 && (
                <span
                  className="flex-none rounded-full bg-amber-400/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-300"
                  title={`This piece has already been posted ${t.useCount} times — the drafter is told which angles are spent.`}
                >
                  {t.useCount}× used
                </span>
              )}
              {t.badges?.map((b) => (
                <span
                  key={b.label}
                  title={b.title}
                  className={`flex-none rounded-full px-1.5 py-0.5 font-mono text-[10px] ${
                    b.tone === "good"
                      ? "bg-emerald-400/15 text-emerald-300"
                      : b.tone === "warn"
                        ? "bg-amber-400/15 text-amber-300"
                        : "bg-white/[0.06] text-white/45"
                  }`}
                >
                  {b.label}
                </span>
              ))}
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

        {shapePicker && (
          <div className="flex flex-wrap items-center gap-1 border-t border-white/[0.06] px-3 py-1.5">
            <span className="mr-1 font-mono text-[10px] uppercase tracking-wider text-white/25">Shape</span>
            <button
              onClick={() => setShapeByKey((m) => ({ ...m, [t.key]: "" }))}
              className={`rounded-md border px-1.5 py-0.5 text-[11px] transition ${
                !shapeByKey[t.key] ? "border-eco-lightblue/50 text-eco-lightblue" : "border-white/10 text-white/45 hover:border-white/25"
              }`}
            >
              Any
            </button>
            {SHAPE_CHOICES.map((sh) => (
              <button
                key={sh.id}
                onClick={() => setShapeByKey((m) => ({ ...m, [t.key]: sh.id }))}
                className={`rounded-md border px-1.5 py-0.5 text-[11px] transition ${
                  shapeByKey[t.key] === sh.id
                    ? "border-eco-lightblue/50 text-eco-lightblue"
                    : "border-white/10 text-white/45 hover:border-white/25"
                }`}
              >
                {sh.label}
              </button>
            ))}
          </div>
        )}

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
  }

  return (
    <div className="mt-3 border-t border-white/[0.07] pt-3">
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
            {mode === "products" && "Pick the product, then the piece behind it. Shapes show which angle has gone cold."}
            {mode === "articles" && "One row per article, not per post — the count is how many times we've already run it."}
            {isBroadDiscovery && "Discover fresh source material, then draft from it. (We never reshare a piece.)"}
            {isQuoteDiscovery && "Quote cards are used once, so there is nothing to re-run — this lane finds new ones."}
            {mode === "docs" &&
              "Pick the audience, then the docs page. Every page on docs.eco.com is here — the ones you've never linked rank first."}
            {mode === "videos" &&
              "Pick a series, then a clip. The whole library is here — clips that have never run on X rank first."}
            {mode === "generic" && "Draft starting copy for this pillar."}
          </span>
        )}
      </div>

      {isQuoteDiscovery && <QuoteDiscovery />}

      {isBroadDiscovery && broad && <WhatWorked broad={broad} />}
      {isBroadDiscovery && (
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

      {mode === "docs" && docsMeta && <DocsHeadline meta={docsMeta} />}
      {mode === "videos" && videosMeta && <VideosHeadline meta={videosMeta} />}

      {/* Docs and Videos — a lane accordion, then its rows. Same two-level shape
          as Product Posts, because both shelves are far too long to read flat. */}
      {(mode === "docs" || mode === "videos") && (
        <div className="space-y-1.5">
          {lanes.length === 0 && (
            <p className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-white/40">
              Nothing on the shelf yet — run the sync to populate it.
            </p>
          )}
          {lanes.map((lane) => {
            const open = openLane === lane.key;
            return (
              <NestedDisclosure
                key={lane.key}
                label={lane.label}
                sublabel={lane.sublabel}
                count={lane.targets.length}
                open={open}
                onToggle={() => setOpenLane(open ? null : lane.key)}
              >
                {lane.hint && <p className="text-[11px] text-white/40">{lane.hint}</p>}
                {lane.targets.map((t) => renderTarget(t))}
              </NestedDisclosure>
            );
          })}
        </div>
      )}

      {/* Products mode — product accordion, then its pieces. */}
      {mode === "products" && (
        <div className="space-y-1.5">
          {products.length === 0 && (
            <p className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-white/40">
              No product coverage in this window.
            </p>
          )}
          {products.map((p) => {
            const open = openProduct === p.key;
            const cold = p.shapes.filter((sh) => sh.count === 0).slice(0, 3);
            return (
              <NestedDisclosure
                key={p.key}
                label={p.label}
                sublabel={p.sublabel}
                count={`${p.targets.length} to draft from`}
                open={open}
                onToggle={() => setOpenProduct(open ? null : p.key)}
              >
                {cold.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-white/25">Never used here</span>
                    {cold.map((sh) => (
                      <span key={sh.shape} className="rounded-md border border-emerald-400/25 bg-emerald-400/[0.07] px-1.5 py-0.5 text-emerald-300/80">
                        {sh.label}
                      </span>
                    ))}
                  </div>
                )}
                <div className="space-y-1.5">{p.targets.map((t) => renderTarget(t, true))}</div>
              </NestedDisclosure>
            );
          })}
        </div>
      )}

      {/* Every other mode: a flat target list. No shape picker — the seven
          shapes were derived from the product pillar, and offering "Partner
          proof" on a thought-leadership article implies a job it doesn't have. */}
      {mode !== "products" && mode !== "docs" && mode !== "videos" && !isQuoteDiscovery && (
        <div className="space-y-1.5">{flatTargets.map((t) => renderTarget(t))}</div>
      )}
    </div>
  );
}

// Mirrors PRODUCT_POST_SHAPES in lib/products.ts. Duplicated as a plain literal
// rather than imported so this client component doesn't pull the server-side
// product briefs (and their prompt text) into the browser bundle.
const SHAPE_CHOICES = [
  { id: "launch", label: "Launch" },
  { id: "problem_mechanism", label: "Problem → mechanism" },
  { id: "how_it_works", label: "How it works" },
  { id: "diagram", label: "Diagram" },
  { id: "partner_proof", label: "Partner proof" },
  { id: "icp_objection", label: "ICP objection" },
  { id: "article_amplifier", label: "Article amplifier" },
];

// The one number that should change behaviour in this pillar, stated plainly.
// The homepage habit costs roughly half the reach of a deep link, and it is the
// single most repeated mistake in the corpus — so the card says so out loud,
// with this month's numbers rather than a figure baked into a comment.
function DocsHeadline({ meta }: { meta: DocsMeta }) {
  const gap =
    meta.homeMedian && meta.deepMedian && meta.homeMedian > 0
      ? meta.deepMedian / meta.homeMedian
      : null;
  return (
    <div className="mb-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-white/30">
        The docs shelf
      </div>
      <p className="text-xs text-white/60">
        <span className="text-white/85">{meta.neverUsed}</span> of{" "}
        <span className="text-white/85">{meta.totalPages}</span> pages on docs.eco.com have never
        been linked from a post.
      </p>
      {gap != null && (
        <p className="mt-1 text-xs text-white/60">
          Deep links run{" "}
          <span className="text-emerald-300">{compact(meta.deepMedian)} median impressions</span>{" "}
          against <span className="text-amber-300">{compact(meta.homeMedian)}</span> for the docs
          homepage — {gap.toFixed(1)}× — across {meta.deepCount} and {meta.homeCount} posts. Pick a
          section, not the front door.
        </p>
      )}
    </div>
  );
}

function VideosHeadline({ meta }: { meta: VideosMeta }) {
  return (
    <div className="mb-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-white/30">
        The clip library
      </div>
      <p className="text-xs text-white/60">
        <span className="text-white/85">{meta.neverPosted}</span> of{" "}
        <span className="text-white/85">{meta.total}</span> finished clips have never run on X.
      </p>
      <p className="mt-1 font-mono text-[10px] text-white/35">
        {meta.withFile} have the file on hand in Dropbox · {meta.withTranscript} have a transcript
        the drafter can quote from
      </p>
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
