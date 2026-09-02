"use client";

import { useState, useTransition } from "react";
import { useAction, ActionProgress } from "./useAction";
import { NestedDisclosure } from "@/app/components/Collapse";
import { useRouter } from "next/navigation";
import { QuoteDiscovery } from "./QuoteDiscovery";
import { AngleBank } from "./AngleBank";
import type { AngleBank as Bank } from "@/lib/angleBank";

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

export type DraftMode = "chains" | "products" | "articles" | "discovery" | "docs" | "videos" | "dmv" | "generic";

// ---------------------------------------------------------------------------
// Per-source draft keys.
//
// A curriculum concept now owns several independent draft stacks: one per source
// plus one per mined question. They share the concept's key prefix so shape
// picks and "which concept is open" still resolve, and each carries its own
// options, error and busy state — drafting from source A does not blow away the
// drafts you already liked from source B.
// ---------------------------------------------------------------------------
const SRC_KEY = "-src";

function sourceKey(conceptKey: string, sourceId: number): string {
  return `${conceptKey}${SRC_KEY}${sourceId}`;
}

/**
 * A URL that resolves to a file rather than a page. 27 of the ~78 verified rows
 * on the shelf are shaped like this (Grok's discovery pass happily returns
 * swift.com/swift-resource/21476/download as "the" URL for a report), and
 * whatever is stored is what gets published into the post body.
 */
function isAssetUrl(url: string): boolean {
  return /\/download\/?($|\?)|\.pdf($|\?)/i.test(url);
}

/** The concept key a derived key belongs to, for state that lives on the concept. */
function shapeScope(key: string): string {
  const i = key.indexOf(SRC_KEY);
  return i === -1 ? key : key.slice(0, i);
}

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
  // A curriculum concept (lib/analogs.ts). Turns the draft into a teaching post.
  analogId?: string | null;
  // One row from analog_sources. Set on a per-source draft: the post argues from
  // that piece alone and is credited to it, instead of the model picking a
  // winner out of a shortlist and every draft landing on the same one.
  sourceId?: number | null;
  // A short body under the row. The curriculum shelf uses it to show WHERE THE
  // ANALOGY BREAKS — which is both the point of the concept and the thing the
  // operator most needs to read before drafting from it.
  note?: string | null;
  // Verified source material behind a curriculum concept. Listed on the row
  // because the operator should be able to see what a draft will be arguing
  // from — and notice when the answer is "nothing" — before spending a draft.
  sources?: {
    id: number;
    title: string;
    url: string;
    publisher: string | null;
    kind: string | null;
    seed: boolean;
    tier: string;
    ageDays: number | null;
    factsCount: number;
    /** We hold the full text. Without it the source is not draftable at all. */
    grounded: boolean;
  }[];
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

// The API's row shape into the shelf's. Tolerant of both, so a row that has
// already been projected (or a future field) survives a round trip.
function asShelfSource(r: Record<string, unknown>): NonNullable<Target["sources"]>[number] {
  const facts = Array.isArray(r.keyFacts) ? r.keyFacts.length : null;
  return {
    id: Number(r.id),
    title: String(r.title ?? ""),
    url: String(r.url ?? ""),
    publisher: (r.publisher as string | null) ?? null,
    kind: (r.kind as string | null) ?? null,
    seed: typeof r.seed === "boolean" ? r.seed : r.sourceOf === "seed",
    tier: String(r.tier ?? "canonical"),
    ageDays: r.ageDays == null ? null : Number(r.ageDays),
    factsCount: facts ?? Number(r.factsCount ?? 0),
    grounded: typeof r.grounded === "boolean" ? r.grounded : r.textDocId != null,
  };
}

// The draft target for ONE source of a concept. Everything about the concept
// rides along (analog id, priors, the break) with the source pinned on top.
function sourceTarget(t: Target, sr: NonNullable<Target["sources"]>[number]): Target {
  return { ...t, key: sourceKey(t.key, sr.id), sourceId: sr.id };
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

// Coverage headline for the curriculum shelf. Deliberately counts CONCEPTS and
// DOORS, not posts — "19 of 20 never taught" is the number that should change
// behaviour, and it is invisible in any post-derived metric.
export interface CurriculumMeta {
  unsourced: number;
  canonicalOnly: number;
  neverSwept: number;
  totalConcepts: number;
  taught: number;
  neverTaught: number;
  coldDoors: string[];
  bySide: { side: string; total: number; taught: number }[];
}

export interface MinedQuestion {
  question: string;
  askedWhere: string;
  frequency: string;
  answeredWell: boolean;
  angle: string;
  asker: string;
  source?: { title: string; url: string };
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
  // Curriculum drafts carry their citation. The link is IN the body now, so
  // there is one thing to copy and one thing to post.
  sourceTitle?: string;
  sourceUrl?: string;
  score?: number;
  scoreNote?: string;
  // What lib/antiSlop.ts still flags after the deterministic fixes and the
  // repair pass. Usually empty. Shown so a weak draft names its own problem.
  slop?: { rule: string; severity: "hard" | "soft"; match: string; fix: string }[];
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
  curriculum = [],
  curriculumMeta,
  trendFlag = "insufficient",
  trendImprPct = null,
  angleBank,
  analogOptions = [],
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
  curriculum?: LaneGroup[];
  curriculumMeta?: CurriculumMeta;
  trendFlag?: "improving" | "flat" | "declining" | "insufficient";
  trendImprPct?: number | null;
  angleBank?: Bank;
  analogOptions?: { id: string; label: string }[];
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
  // Fan-out runs several drafts at once, so "which row is busy" stops being a
  // single value. loadingKey still drives the ETA bar for a lone draft; this set
  // is what greys the individual source buttons.
  const [busyKeys, setBusyKeys] = useState<Record<string, true>>({});
  // Which concept is mid fan-out, and how far it has got. A five-source click is
  // a two-minute wait, and "3 of 5" is the only honest thing to show during it.
  const [fanKey, setFanKey] = useState<string | null>(null);
  const [fanDone, setFanDone] = useState<{ done: number; total: number; failed: number }>({ done: 0, total: 0, failed: 0 });
  const [optionsByKey, setOptionsByKey] = useState<Record<string, CopyOption[]>>({});
  const [errByKey, setErrByKey] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<{ key: string; idx: number } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [shapeByKey, setShapeByKey] = useState<Record<string, string>>({});

  // Which product accordion is open (products mode).
  const [openProduct, setOpenProduct] = useState<string | null>(products[0]?.key ?? null);
  // Which lane is open (docs / videos modes). Opens on the top-ranked lane,
  // which is the coldest audience or series — the answer to "what now".
  const [openLane, setOpenLane] = useState<string | null>(lanes[0]?.key ?? null);
  // The curriculum accordion is independent of `openLane` — both can be on
  // screen at once inside the Broad Educational card (news lane + teach lane).
  const [openCurr, setOpenCurr] = useState<string | null>(curriculum[0]?.key ?? null);

  // Question mining, keyed by concept target. Demand discovery, not news
  // discovery: what people ASK about a mechanism, ranked unanswered-first.
  const [questionsByKey, setQuestionsByKey] = useState<Record<string, MinedQuestion[]>>({});
  const [miningKey, setMiningKey] = useState<string | null>(null);
  const [mineErrByKey, setMineErrByKey] = useState<Record<string, string>>({});

  // Source discovery. Every URL is HTTP-checked server-side before it is
  // stored, so what lands here is citable, not merely plausible.
  const [sourcesByKey, setSourcesByKey] = useState<Record<string, NonNullable<Target["sources"]>>>({});
  const [findingKey, setFindingKey] = useState<string | null>(null);
  const [srcErrByKey, setSrcErrByKey] = useState<Record<string, string>>({});
  const [srcNoteByKey, setSrcNoteByKey] = useState<Record<string, string>>({});

  // Progress + completion chime. The per-row *Key state above still says WHICH
  // row is busy; these say how far along it is and how long is left.
  const draftAct = useAction("generate");
  const draftAllAct = useAction("generate-all");
  const sourcesAct = useAction("analog-sources");
  const mineAct = useAction("questions");
  const discoverAct = useAction("discover");


  const isBroadDiscovery = mode === "discovery" && template === "broad_educational";
  const isQuoteDiscovery = mode === "discovery" && template === "quote_card";
  const flatTargets = isBroadDiscovery ? discovered : targets;

  // One draft request, with no progress-bar bookkeeping around it. Split out of
  // draft() so the fan-out can run several of these at once: useAction holds a
  // single pending flag, so N concurrent .run() calls would have the first one
  // to land clear the bar while the rest were still going.
  //
  // Resolves true on success. Never throws — a fan-out leg that fails writes its
  // own error under its own row and leaves the other legs alone.
  async function requestDraft(t: Target, shape?: string | null): Promise<boolean> {
    setBusyKeys((b) => ({ ...b, [t.key]: true }));
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
          analogId: t.analogId ?? null,
          // Set on a per-source draft. The server then builds a single-source
          // prompt and pins the citation to that row, so the post is grounded in
          // the piece the operator clicked rather than in whichever of four
          // shortlisted sources had the strongest quote.
          sourceId: t.sourceId ?? null,
          // The seven product shapes and the six teaching shapes are different
          // vocabularies; a target is only ever one kind, so the picked value
          // routes to whichever field applies.
          //
          // A per-source key inherits the shape picked on the CONCEPT row, since
          // the picker lives there and applies to the whole concept.
          eduShape: t.analogId ? (shape ?? shapeByKey[shapeScope(t.key)] ?? null) : null,
          shape: t.analogId ? null : (shape ?? shapeByKey[t.key] ?? null),
          angle: t.angle ?? null,
          basePostText: t.basePostText ?? null,
          priorTexts: t.priorTexts ?? [],
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setOptionsByKey((o) => ({ ...o, [t.key]: data.options ?? [] }));
        return true;
      }
      setErrByKey((e) => ({ ...e, [t.key]: data.error || "Failed" }));
      return false;
    } catch (e) {
      setErrByKey((err) => ({ ...err, [t.key]: e instanceof Error ? e.message : "Failed" }));
      return false;
    } finally {
      setBusyKeys((b) => {
        const next = { ...b };
        delete next[t.key];
        return next;
      });
    }
  }

  async function draft(t: Target, shape?: string | null) {
    setActiveKey(t.key);
    setSelected(null);
    setLoadingKey(t.key);
    try {
      await draftAct.run(() => requestDraft(t, shape));
    } finally {
      setLoadingKey(null);
    }
  }

  // The concept-level click: one draft per verified source, each grounded in
  // that source alone.
  //
  // Fanned out from the browser rather than the server on purpose. Each leg is
  // its own function invocation, so drafts appear as they land instead of after
  // the slowest one, a single bad source cannot take down the click, and no
  // request has to fit N sequential model calls inside one 60s Vercel ceiling.
  //
  // Concurrency is capped at 3. The local CLI backend spawns a `claude` process
  // per call; five at once is a lot of machine for one click, and the API path
  // has per-minute limits worth staying under.
  const FANOUT_CONCURRENCY = 3;
  // Hard ceiling on one click, mirroring MAX_FANOUT_SOURCES in
  // lib/analogSources.ts (not imported: that module pulls in the Neon driver,
  // which has no business in a client bundle). The shelf's widest concept has 8
  // sources today, so this binds on nothing — it exists so a future sweep that
  // returns forty cannot turn one click into forty model calls.
  const FANOUT_MAX = 10;

  async function draftAllSources(t: Target) {
    const all = sourcesByKey[t.key] ?? t.sources ?? [];
    // Ungrounded sources are skipped rather than dispatched: each would be a
    // model call that throws on the grounding gate, so a fan-out over a shelf
    // of un-ingested rows would spend N requests to produce N identical errors.
    // Their own rows already say "not ingested".
    const srcs = all.filter((s) => s.grounded).slice(0, FANOUT_MAX);
    if (!t.analogId || srcs.length === 0) return;

    // One source is not a fan-out. Run it as a plain draft so it gets the
    // single-draft ETA bar rather than the two-wave estimate.
    if (srcs.length === 1) {
      await draft(sourceTarget(t, srcs[0]));
      return;
    }

    setActiveKey(t.key);
    setSelected(null);
    setFanKey(t.key);
    setFanDone({ done: 0, total: srcs.length, failed: 0 });

    const queue = [...srcs];
    try {
      await draftAllAct.run(async () => {
        async function worker() {
          for (;;) {
            const sr = queue.shift();
            if (!sr) return;
            const ok = await requestDraft(sourceTarget(t, sr));
            setFanDone((f) => ({ ...f, done: f.done + 1, failed: f.failed + (ok ? 0 : 1) }));
          }
        }
        await Promise.all(Array.from({ length: Math.min(FANOUT_CONCURRENCY, queue.length) }, worker));
      });
    } finally {
      setFanKey(null);
    }
  }

  async function copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  async function findSources(t: Target) {
    if (!t.analogId) return;
    setFindingKey(t.key);
    setSrcErrByKey((e) => ({ ...e, [t.key]: "" }));
    setSrcNoteByKey((n) => ({ ...n, [t.key]: "" }));
    try {
      const data = await sourcesAct.run(async () => {
        const res = await fetch("/api/analog-sources", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ analogId: t.analogId }),
        });
        return res.json();
      });
      if (data.ok) {
        // /api/analog-sources returns raw AnalogSource rows, which are NOT the
        // shape the shelf renders — sourceOf/keyFacts there, seed/factsCount
        // here. res.json() is `any`, so this went unchecked: after a sweep the
        // "vetted" chip and the fact count silently vanished until a reload.
        // It matters more now that these rows carry a draft button keyed on id.
        setSourcesByKey((m) => ({ ...m, [t.key]: (data.sources ?? []).map(asShelfSource) }));
        setSrcNoteByKey((n) => ({
          ...n,
          [t.key]: [
            `+${data.added} kept`,
            data.rejected ? `${data.rejected} rejected` : null,
            data.scanned ? `${data.scanned} scanned` : null,
            data.credits ? `${data.credits} credits` : null,
            data.partial ? "partial, ran out of time" : null,
          ]
            .filter(Boolean)
            .join(" · "),
        }));
        startTransition(() => router.refresh());
      } else setSrcErrByKey((e) => ({ ...e, [t.key]: data.error || "Source search failed" }));
    } catch (e) {
      setSrcErrByKey((err) => ({ ...err, [t.key]: e instanceof Error ? e.message : "Source search failed" }));
    } finally {
      setFindingKey(null);
    }
  }

  async function mine(t: Target) {
    if (!t.analogId) return;
    setMiningKey(t.key);
    setMineErrByKey((e) => ({ ...e, [t.key]: "" }));
    try {
      const data = await mineAct.run(async () => {
        const res = await fetch("/api/questions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ analogId: t.analogId }),
        });
        return res.json();
      });
      if (data.ok) setQuestionsByKey((q) => ({ ...q, [t.key]: data.questions ?? [] }));
      else setMineErrByKey((e) => ({ ...e, [t.key]: data.error || "Question mining failed" }));
    } catch (e) {
      setMineErrByKey((err) => ({ ...err, [t.key]: e instanceof Error ? e.message : "Question mining failed" }));
    } finally {
      setMiningKey(null);
    }
  }

  async function runDiscover() {
    setDiscovering(true);
    setDiscoverErr(null);
    setDiscoverWarn([]);
    try {
      const data = await discoverAct.run(async () => {
        const res = await fetch("/api/discover", { method: "POST" });
        return res.json();
      });
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

  // Extracted so drafts can render in TWO places: under a target row, and under
  // an individual mined question (which owns its own key, because answering
  // "why does a wire take two days" is a different post from a general T+2
  // explainer and should not overwrite it).
  function renderDrafts(key: string, target: Target) {
    const opts = optionsByKey[key];
    const err = errByKey[key];
    if (!opts && !err) return null;
    return (
      <div className="space-y-2 border-t border-white/[0.06] px-3 pb-3 pt-2">

            {err && <p className="font-mono text-[11px] text-red-400">{err}</p>}
            {opts?.map((o, i) => {
              const isSel = selected?.key === key && selected.idx === i;
              return (
                <div
                  key={i}
                  onClick={() => setSelected({ key: key, idx: i })}
                  className={`cursor-pointer rounded-lg border p-2.5 transition ${
                    isSel ? "border-eco-lightblue/50 bg-eco-lightblue/[0.06]" : "border-white/10 bg-white/[0.02] hover:border-white/25"
                  }`}
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-eco-lightblue/80">
                      <span className={`inline-block h-2.5 w-2.5 flex-none rounded-full border ${isSel ? "border-eco-lightblue bg-eco-lightblue" : "border-white/30"}`} />
                      <span className="truncate">{o.angle}</span>
                      <span
                        title={
                          o.text.length < 280
                            ? "Tight band, under 280 characters."
                            : o.text.length < 900
                              ? "Mid band, 400 to 900 characters."
                              : "Long form, 900 to 2000 characters. Earns dwell when the material has steps."
                        }
                        className="flex-none cursor-help rounded-full bg-white/[0.06] px-1.5 py-0.5 tabular-nums text-white/45"
                      >
                        {o.text.length < 280 ? "tight" : o.text.length < 900 ? "mid" : "long"} {o.text.length}
                      </span>
                      {o.score != null && (
                        <span
                          title={
                            o.scoreNote
                              ? `Self-scored against the X ranking signals. Weakest: ${o.scoreNote}`
                              : "Self-scored against the X ranking signals (citability, reply pull, dwell, hook honesty)."
                          }
                          className={`flex-none cursor-help rounded-full px-1.5 py-0.5 tabular-nums ${
                            o.score >= 80
                              ? "bg-emerald-400/15 text-emerald-300"
                              : o.score >= 65
                                ? "bg-white/[0.06] text-white/55"
                                : "bg-amber-400/15 text-amber-300"
                          }`}
                        >
                          {o.score}
                        </span>
                      )}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); copy(o.text, `${key}-post-${i}`); }}
                      className="rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-white/60 transition hover:border-white/30 hover:text-white/90"
                    >
                      {copiedId === `${key}-post-${i}` ? "Copied ✓" : "Copy"}
                    </button>
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-white/85">{o.text}</p>
                  {o.rationale && <p className="mt-1 text-[11px] italic text-white/40">{o.rationale}</p>}

                  {/* Anti-slop findings. Em dashes, thread markers and markdown
                      are already fixed in code before this renders, so anything
                      here needed a judgment call the linter would not make. */}
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

                  {/* The citation. One line, not a second thing to publish:
                      the link is already in the post body above, so this is a
                      provenance label the operator can click to check the claim
                      before posting. */}
                  {o.sourceTitle && (
                    <div className="mt-2 flex items-baseline gap-2 border-t border-white/[0.06] pt-1.5">
                      <span className="flex-none font-mono text-[9.5px] uppercase tracking-wider text-white/30">
                        Argued from
                      </span>
                      <span className="min-w-0 text-[11.5px] leading-snug text-white/60">
                        {o.sourceUrl ? (
                          <a
                            href={o.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="underline decoration-white/20 underline-offset-2 hover:text-eco-lightblue"
                          >
                            {o.sourceTitle}
                          </a>
                        ) : (
                          o.sourceTitle
                        )}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}

            {opts && opts.length > 0 && <p className="text-[10px] text-white/30">Starting points — take them to 90/10 before posting.</p>}
      </div>
    );
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
          {t.analogId && (
            <button
              onClick={() => findSources(t)}
              disabled={findingKey === t.key}
              title="Run the same sweep the daily cron runs: Firecrawl search plus the institution's own publication hub, then a keep/reject pass. Costs about 9-13 Firecrawl credits."
              className="flex-none rounded-full border border-white/15 px-3 py-1 text-xs font-medium text-white/60 transition hover:border-eco-lightblue hover:text-eco-lightblue disabled:opacity-50"
            >
              {findingKey === t.key ? "Sweeping…" : "Sweep now"}
            </button>
          )}
          {t.analogId && (
            <button
              onClick={() => mine(t)}
              disabled={miningKey === t.key}
              title="Search YouTube, X, Reddit and forums for the questions people actually ask about this mechanism. Unanswered and recurring rank first."
              className="flex-none rounded-full border border-white/15 px-3 py-1 text-xs font-medium text-white/60 transition hover:border-eco-lightblue hover:text-eco-lightblue disabled:opacity-50"
            >
              {miningKey === t.key ? "Mining…" : questionsByKey[t.key] ? "Re-mine" : "Find questions"}
            </button>
          )}
          {/* On a concept, the top-level button drafts from EVERY source — one
              call each, so five sources give five separately grounded stacks
              instead of three drafts that all lean on whichever source had the
              best quote. Per-source buttons below do one at a time; this is the
              "give me the whole set" click, and it is priced accordingly. */}
          {t.analogId ? (
            (() => {
              const n = Math.min((sourcesByKey[t.key] ?? t.sources ?? []).length, FANOUT_MAX);
              const running = fanKey === t.key;
              return (
                <button
                  onClick={() => draftAllSources(t)}
                  disabled={running || n === 0}
                  title={
                    n === 0
                      ? "No verified sources yet — run Sweep now first."
                      : n === 1
                        ? "Draft from the one source behind this concept."
                        : `One draft call per source, ${n} in total, run ${FANOUT_CONCURRENCY} at a time. Each post argues from a single piece and credits it. Costs ${n}× a single draft.`
                  }
                  className="flex-none rounded-full border border-white/15 px-3 py-1 text-xs font-medium text-white/70 transition hover:border-eco-lightblue hover:text-eco-lightblue disabled:opacity-50"
                >
                  {running
                    ? `Drafting ${fanDone.done}/${fanDone.total}…`
                    : n > 1
                      ? `Draft from all ${n} sources`
                      : "Draft copy"}
                </button>
              );
            })()
          ) : (
            <button
              onClick={() => draft(t)}
              disabled={isLoading}
              className="flex-none rounded-full border border-white/15 px-3 py-1 text-xs font-medium text-white/70 transition hover:border-eco-lightblue hover:text-eco-lightblue disabled:opacity-50"
            >
              {isLoading ? "Drafting…" : opts ? "Redraft" : "Draft copy"}
            </button>
          )}
        </div>

        {/* One bar per row, under the button strip. Keyed off the per-row
            *Key state so a draft running on another row does not animate
            this one. */}
        {loadingKey === t.key && <ActionProgress state={draftAct.state} />}
        {findingKey === t.key && <ActionProgress state={sourcesAct.state} />}
        {miningKey === t.key && <ActionProgress state={mineAct.state} />}
        {/* The fan-out bar is the whole click, not one leg of it, and the
            counter under it is what actually tells you where you are. */}
        {fanKey === t.key && (
          <>
            <ActionProgress state={draftAllAct.state} />
            <p className="mt-1 font-mono text-[10px] text-white/35">
              {fanDone.done} of {fanDone.total} sources drafted
              {fanDone.failed > 0 && <span className="text-amber-300/70"> · {fanDone.failed} failed</span>}
            </p>
          </>
        )}

        {/* The evidence base, listed before the teaching content. A curriculum
            draft argues FROM one of these, so seeing them — or seeing that
            there are none — is what tells the operator whether drafting is
            even worth a click. */}
        {t.analogId && (() => {
          const srcs = sourcesByKey[t.key] ?? t.sources ?? [];
          const note = srcNoteByKey[t.key];
          const err = srcErrByKey[t.key];
          return (
            <div className="border-t border-white/[0.06] px-3 py-2">
              <div className="mb-1 flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-[10px] uppercase tracking-wider text-white/30">
                  Source material
                </span>
                {note && <span className="font-mono text-[10px] text-emerald-300/70">{note}</span>}

              </div>
              {err && <p className="font-mono text-[11px] text-red-400">{err}</p>}
              {srcs.length === 0 ? (
                <p className="text-[11px] text-amber-300/70">
                  Nothing citable yet. Drafting is blocked until this concept has a source.
                </p>
              ) : (
                /* Every source, not the top five. The list used to be a
                   read-only summary, so truncating it only cost information;
                   now each row is the draft button for that piece, and a hidden
                   row is a post you cannot write. */
                <ul className="space-y-1">
                  {srcs.map((sr) => {
                    const sKey = sourceKey(t.key, sr.id);
                    const sOpts = optionsByKey[sKey];
                    const sBusy = !!busyKeys[sKey];
                    return (
                      <li key={sr.id} className="rounded-lg border border-white/[0.07] bg-white/[0.015]">
                        <div className="flex items-start gap-2 px-2 py-1.5">
                          <div className="min-w-0 flex-1 text-[11.5px] leading-snug text-white/55">
                            <a
                              href={sr.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-white/75 underline decoration-white/20 underline-offset-2 hover:text-eco-lightblue"
                            >
                              {sr.title}
                            </a>
                            {sr.publisher && <span className="text-white/40"> — {sr.publisher}</span>}
                            {sr.kind && sr.kind !== "article" && (
                              <span className="ml-1.5 font-mono text-[9.5px] uppercase tracking-wider text-white/30">{sr.kind}</span>
                            )}
                            <span
                              title={
                                sr.tier === "current"
                                  ? "Recent material. This is what lets a draft be timely."
                                  : "Explains the mechanism itself. This is what makes a draft correct."
                              }
                              className={`ml-1.5 rounded-full px-1.5 py-0.5 font-mono text-[9.5px] ${
                                sr.tier === "current" ? "bg-eco-lightblue/15 text-eco-lightblue" : "bg-white/[0.06] text-white/40"
                              }`}
                            >
                              {sr.tier}
                              {sr.tier === "current" && sr.ageDays != null ? ` ${sr.ageDays}d` : ""}
                            </span>
                            {sr.factsCount > 0 && (
                              <span
                                className="ml-1 font-mono text-[9.5px] text-white/25"
                                title={`${sr.factsCount} checkable claims extracted from this piece.`}
                              >
                                {sr.factsCount}f
                              </span>
                            )}
                            {sr.seed && (
                              <span
                                className="ml-1.5 rounded-full bg-emerald-400/15 px-1.5 py-0.5 font-mono text-[9.5px] text-emerald-300"
                                title="Hand-picked — a person on the team actually read or watched this one."
                              >
                                vetted
                              </span>
                            )}
                            {/* A citation that publishes as a raw file download
                                reads as a dead link in a feed, and a third of
                                the shelf's stored URLs are shaped like this.
                                Flagged rather than hidden: the source is still
                                good, the URL is just the wrong one to publish. */}
                            {isAssetUrl(sr.url) && (
                              <span
                                className="ml-1.5 rounded-full bg-amber-400/12 px-1.5 py-0.5 font-mono text-[9.5px] text-amber-300/80"
                                title="This URL points straight at a file download rather than a page. Drafts from it will publish that link — swap it for the landing page before posting."
                              >
                                file link
                              </span>
                            )}
                            {/* The drafting gate. A source we hold only as
                                metadata produced posts that cited it for
                                claims it never made, because the drafter had
                                nothing to check against. Shown on the row so
                                the reason is visible before the click. */}
                            {!sr.grounded && (
                              <span
                                className="ml-1.5 rounded-full bg-rose-400/12 px-1.5 py-0.5 font-mono text-[9.5px] text-rose-300/80"
                                title="Not ingested — we have this source's metadata but not the piece itself, so nothing can verify what it actually says. Run scripts/ingest-analog-sources.ts (web) or scripts/sweep-channels.ts (podcasts) to make it draftable."
                              >
                                not ingested
                              </span>
                            )}
                            {sOpts && (
                              <span className="ml-1.5 font-mono text-[9.5px] text-eco-lightblue/70">
                                {sOpts.length} draft{sOpts.length === 1 ? "" : "s"}
                              </span>
                            )}
                          </div>
                          <button
                            onClick={() => draft(sourceTarget(t, sr))}
                            disabled={sBusy || !sr.grounded}
                            title={
                              sr.grounded
                                ? `Draft from this piece only. One model call, and every draft it returns argues from and credits "${sr.title}".`
                                : "Not draftable: we hold this source's metadata but never ingested the piece, so no claim about it can be verified. Ingest it first."
                            }
                            className="flex-none rounded-full border border-white/15 px-2.5 py-0.5 text-[11px] font-medium text-white/65 transition hover:border-eco-lightblue hover:text-eco-lightblue disabled:opacity-50 disabled:hover:border-white/15 disabled:hover:text-white/65"
                          >
                            {sBusy ? "Drafting…" : !sr.grounded ? "Not ingested" : sOpts ? "Redraft" : "Draft from this"}
                          </button>
                        </div>
                        {/* This source's ETA bar, only when it is the lone draft
                            running. During a fan-out the concept-level counter
                            is the honest progress read. */}
                        {loadingKey === sKey && <ActionProgress state={draftAct.state} className="px-2 pb-1.5" />}
                        {/* And this source's drafts, under this source. */}
                        {(sOpts || errByKey[sKey]) && renderDrafts(sKey, sourceTarget(t, sr))}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })()}

        {/* Where the analogy breaks. Shown unprompted rather than behind a
            disclosure: this is the actual content of the concept, and reading it
            is the point of the shelf even on the days you don't draft from it. */}
        {t.note && (
          <div className="border-t border-white/[0.06] px-3 py-2">
            <span className="mr-1.5 font-mono text-[10px] uppercase tracking-wider text-eco-lightblue/70">Breaks</span>
            <span className="text-[12px] leading-relaxed text-white/60">{t.note}</span>
          </div>
        )}

        {/* Mined questions. Each one is itself draftable — the question becomes
            the angle, which is the whole point: we are answering a real ask, not
            publishing an explainer into the void. */}
        {(questionsByKey[t.key] || mineErrByKey[t.key] || miningKey === t.key) && (
          <div className="space-y-1.5 border-t border-white/[0.06] px-3 py-2">
            <div className="font-mono text-[10px] uppercase tracking-wider text-white/30">
              Questions people ask

            </div>
            {mineErrByKey[t.key] && <p className="font-mono text-[11px] text-red-400">{mineErrByKey[t.key]}</p>}
            {questionsByKey[t.key]?.length === 0 && (
              <p className="text-[11px] text-white/35">Nothing came back — try re-mining.</p>
            )}
            {questionsByKey[t.key]?.map((q, i) => (
              <div key={i} className="rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[13px] text-white/85">{q.question}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-white/35">
                      {!q.answeredWell && (
                        <span
                          className="rounded-full bg-emerald-400/15 px-1.5 py-0.5 text-emerald-300"
                          title="No good public answer exists — this is the opening."
                        >
                          Unanswered
                        </span>
                      )}
                      {q.frequency === "recurring" && (
                        <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-white/50">Recurring</span>
                      )}
                      {q.asker && <span>{q.asker}</span>}
                      {q.askedWhere && <span>· {q.askedWhere}</span>}
                      {q.source?.url && (
                        <a href={q.source.url} target="_blank" rel="noreferrer" className="underline hover:text-eco-lightblue">
                          source
                        </a>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() =>
                      draft({
                        ...t,
                        key: `${t.key}-q${i}`,
                        angle: q.angle,
                        basePostText: `Answer this question: "${q.question}"`,
                      })
                    }
                    disabled={loadingKey === `${t.key}-q${i}`}
                    className="flex-none rounded-full border border-white/15 px-2.5 py-1 text-[11px] font-medium text-white/70 transition hover:border-eco-lightblue hover:text-eco-lightblue disabled:opacity-50"
                  >
                    {loadingKey === `${t.key}-q${i}` ? "Drafting…" : "Answer it"}
                  </button>
                  {loadingKey === `${t.key}-q${i}` && <ActionProgress state={draftAct.state} />}
                </div>
                {q.angle && <p className="mt-1 text-[11px] italic text-white/40">{q.angle}</p>}
                {/* The draft for THIS question renders under it, not under the concept. */}
                {activeKey === `${t.key}-q${i}` && renderDrafts(`${t.key}-q${i}`, { ...t, key: `${t.key}-q${i}`, angle: q.angle })}
              </div>
            ))}
          </div>
        )}

        {shapePicker && (
          <div className="flex flex-wrap items-center gap-1 border-t border-white/[0.06] px-3 py-1.5">
            <span className="mr-1 font-mono text-[10px] uppercase tracking-wider text-white/25">
              {t.analogId ? "Teaching shape" : "Shape"}
            </span>
            <button
              onClick={() => setShapeByKey((m) => ({ ...m, [t.key]: "" }))}
              className={`rounded-md border px-1.5 py-0.5 text-[11px] transition ${
                !shapeByKey[t.key] ? "border-eco-lightblue/50 text-eco-lightblue" : "border-white/10 text-white/45 hover:border-white/25"
              }`}
            >
              Any
            </button>
            {(t.analogId ? EDU_SHAPE_CHOICES : SHAPE_CHOICES).map((sh) => (
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

        {isActive && renderDrafts(t.key, t)}
      </div>
    );
  }

  return (
    <div className="mt-3 border-t border-white/[0.07] pt-3">
      <div className="mb-2 text-xs text-white/40">
        {trendFlag !== "insufficient" && trendImprPct != null ? (
          <span>
            <span
              className={
                trendFlag === "improving"
                  ? "text-emerald-300/80"
                  : trendFlag === "declining"
                    ? "text-amber-300/80"
                    : "text-white/45"
              }
            >
              Last 5 {trendImprPct >= 0 ? "up" : "down"} {Math.abs(trendImprPct).toFixed(0)}%
            </span>{" "}
            vs the 5 before ·{" "}
            <a href="/history" className="underline decoration-white/20 hover:text-white/70">
              trend
            </a>
          </span>
        ) : (
          <span className="text-white/30">
            {mode === "chains" && "Pick a chain angle and draft copy for it."}
            {mode === "products" && "Pick the product, then the piece behind it. Shapes show which angle has gone cold."}
            {mode === "articles" && "One row per article, not per post — the count is how many times we've already run it."}
            {isBroadDiscovery &&
              "Two jobs in one pillar: teach a mechanism nobody has explained, or find fresh market news. (We never reshare a piece.)"}
            {isQuoteDiscovery && "Quote cards are used once, so there is nothing to re-run — this lane finds new ones."}
            {mode === "docs" &&
              "Pick the audience, then the docs page. Every page on docs.eco.com is here — the ones you've never linked rank first."}
            {mode === "videos" &&
              "Pick a series, then a clip. The whole library is here — clips that have never run on X rank first."}
            {mode === "dmv" &&
              "Three lanes, three clocks. Integrated chains can close on Eco; non-integrated ones are a market play; market-wide data has no chain subject at all."}
            {mode === "generic" && "Draft starting copy for this pillar."}
          </span>
        )}
      </div>

      {isQuoteDiscovery && <QuoteDiscovery />}

      {/* ------------------------------------------------------------------
          Broad Educational renders as TWO LANES, because it is doing two jobs.
          Everything in this pillar today is market news; a curriculum post is a
          different act — it teaches a mechanism instead of reporting a signal.
          They share a pillar (an analog explainer IS external, mechanism-level,
          Eco-unnamed content) but they do not share a clock: news decays, a
          concept we have never taught does not.
          ------------------------------------------------------------------ */}
      {/* ------------------------------------------------------------------
          The angle bank comes FIRST, and it is what used to be a draft button.
          The drafter on this pillar could turn a source into a post; what was
          missing sat a step earlier — the frame, and how it reaches what Eco
          does. Jay's call on 2 Sep was to work those out by hand before
          automating anything here, and to let the tracker keep score of them
          meanwhile. So the pillar leads with the bank, and the two shelves below
          are the raw material for filling it.
          ------------------------------------------------------------------ */}
      {isBroadDiscovery && angleBank && (
        <div className="mb-4">
          <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-white/40">Angle bank</span>
            <span className="text-[11px] text-white/30">
              the frames you&apos;ve worked out — no drafting here on purpose, this pillar is worked by hand until a
              few of these have landed
            </span>
          </div>
          <AngleBank bank={angleBank} analogs={analogOptions} />
        </div>
      )}

      {isBroadDiscovery && curriculum.length > 0 && (
        <div className="mb-4">
          <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-white/40">Lane 1 · Analog curriculum</span>
            <span className="text-[11px] text-white/30">
              teach the mechanism the market runs on — ranked by what we have never covered
            </span>
          </div>
          {curriculumMeta && <CurriculumHeadline meta={curriculumMeta} />}
          <div className="space-y-1.5">
            {curriculum.map((lane) => {
              const open = openCurr === lane.key;
              return (
                <NestedDisclosure
                  key={lane.key}
                  label={lane.label}
                  sublabel={lane.sublabel}
                  count={lane.targets.length}
                  open={open}
                  onToggle={() => setOpenCurr(open ? null : lane.key)}
                >
                  {lane.hint && <p className="text-[11px] text-white/40">{lane.hint}</p>}
                  <div className="space-y-1.5">{lane.targets.map((t) => renderTarget(t, true))}</div>
                </NestedDisclosure>
              );
            })}
          </div>
        </div>
      )}

      {isBroadDiscovery && (
        <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-white/40">Lane 2 · Market news</span>
          <span className="text-[11px] text-white/30">what is happening right now — ranked by freshness</span>
        </div>
      )}

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
          {discovering && <ActionProgress state={discoverAct.state} className="max-w-md" />}
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
      {(mode === "docs" || mode === "videos" || mode === "dmv") && (
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
      {mode !== "products" && mode !== "docs" && mode !== "videos" && mode !== "dmv" && !isQuoteDiscovery && (
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

// Mirrors EDUCATION_SHAPES in lib/analogs.ts, duplicated as a plain literal for
// the same reason as above — this is a client component and importing the
// registry would ship every concept's parallel and break text to the browser.
// These are narrative moves lifted from the tradfi explainers themselves, not
// the product-post shapes: "Problem → mechanism" means something different when
// the subject is correspondent banking than when it is Flash Intents.
const EDU_SHAPE_CHOICES = [
  { id: "kill_the_model", label: "Kill the naive model" },
  { id: "condition_then_discipline", label: "Condition → discipline" },
  { id: "three_variable_tradeoff", label: "Three-variable tradeoff" },
  { id: "hidden_cost", label: "Price the hidden cost" },
  { id: "integrate_vs_operate", label: "Integrate vs operate" },
  { id: "closed_loop", label: "Closed loop" },
];

// Coverage headline. Concepts and doors, not posts — the honest read of this
// shelf on day one is "19 of 20 never taught", and no post-derived metric can
// say that, because the posts do not exist yet.
function CurriculumHeadline({ meta }: { meta: CurriculumMeta }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-[11px]">
      <span className="text-white/60">
        <span className="font-mono tabular-nums text-white/85">
          {meta.neverTaught}/{meta.totalConcepts}
        </span>{" "}
        concepts never taught
      </span>
      {meta.bySide.map((s) => (
        <span key={s.side} className="text-white/45">
          {s.side === "commercial" ? "Commercial" : "Technical"} door{" "}
          <span className="font-mono tabular-nums text-white/70">
            {s.taught}/{s.total}
          </span>
        </span>
      ))}
      {meta.canonicalOnly > 0 && (
        <span
          className="text-white/45"
          title="These have a mechanism source but nothing recent, so they can be taught but not made timely."
        >
          <span className="font-mono tabular-nums">{meta.canonicalOnly}</span> evergreen-only
        </span>
      )}
      {meta.neverSwept > 0 && (
        <span className="text-white/45" title="The daily sweep has not reached these yet. It rotates oldest-first.">
          <span className="font-mono tabular-nums">{meta.neverSwept}</span> never swept
        </span>
      )}
      {meta.unsourced > 0 && (
        <span
          className="text-amber-300/70"
          title="These concepts have no verified source material, so they cannot be drafted yet. Run Find sources on them."
        >
          <span className="font-mono tabular-nums">{meta.unsourced}</span> unsourced
        </span>
      )}
      {meta.coldDoors.length > 0 && (
        <span className="text-amber-300/70" title="No concept naming these audiences has ever been taught.">
          Never reached: {meta.coldDoors.join(", ")}
        </span>
      )}
    </div>
  );
}

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
