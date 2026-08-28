import {
  getInsights,
  type Recommendation,
  type Readiness,
  type ArticleShelfRow,
  type BroadEdBreakdown,
  type CurriculumShelf,
  type CurriculumRow,
} from "@/lib/stats";
import { getReviewCount } from "@/lib/queries";
import { Sidebar } from "@/app/components/Sidebar";
import { FilterBar } from "@/app/components/FilterBar";
import { parseFilter } from "@/lib/filter";
import { Eyebrow, Badge, Thumb, Tooltip } from "@/app/components/ui";
import { writtenDate, daysAgo, compact } from "@/lib/format";
import { pickThumb } from "@/lib/media";
import { METRIC_DEFS } from "@/lib/metricDefs";
import {
  RecActions,
  type Target,
  type ProductGroup,
  type LaneGroup,
  type DocsMeta,
  type VideosMeta,
  type CurriculumMeta,
} from "@/app/components/RecActions";
import type { DocShelfRow, HomepagePenalty } from "@/lib/docs";
import type { VideoShelfRow } from "@/lib/videos";
import { ICP_DEFS } from "@/lib/icp";
import { SERIES_DEFS } from "@/lib/videos";
import { TEMPLATE_BY_ID } from "@/lib/taxonomy";
import { TIER_LABEL as ANALOG_TIER_LABEL, TIER_HINT as ANALOG_TIER_HINT, type AnalogTier } from "@/lib/analogs";
import { ExpandableCard, CollapsibleSection } from "@/app/components/Collapse";

export const dynamic = "force-dynamic";

const READINESS_LABEL: Record<Readiness, string> = {
  due: "Due",
  soon: "Soon",
  fresh: "Just posted",
  never: "Never posted",
};

function readinessBadge(r: Readiness) {
  const tone = r === "due" ? "warning" : r === "never" ? "brand" : "neutral";
  return <Badge tone={tone}>{READINESS_LABEL[r]}</Badge>;
}

function mediaLabel(t: string | null): string | null {
  switch (t) {
    case "video": return "video";
    case "animated_gif": return "GIF";
    case "photo": return "image";
    case "link-card": return "article/link";
    case "text": return "text";
    default: return null;
  }
}

function scoreTone(score: number): string {
  if (score >= 66) return "border-red-400/40 bg-red-400/10 text-red-300";
  if (score >= 33) return "border-amber-300/40 bg-amber-300/10 text-amber-200";
  return "border-white/15 bg-white/[0.04] text-white/70";
}

export default async function PrioritizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filter = parseFilter(await searchParams);
  const [
    {
      recommendations,
      reAmplify,
      recentChains,
      thoughtLeadership,
      broadEducational,
      docPages,
      homepagePenalty,
      videos,
      curriculum,
    },
    reviewCount,
  ] = await Promise.all([getInsights(filter), getReviewCount()]);

  const dueCount = recommendations.filter((r) => r.score > 0).length;

  return (
    <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6">
      <Sidebar reviewCount={reviewCount} />
      <main className="min-w-0 flex-1">
        <Eyebrow>Prioritize</Eyebrow>
        <h1 className="mt-1.5 text-2xl font-medium tracking-[-0.02em]">What should I post next?</h1>
        <p className="mt-1 max-w-2xl text-sm text-white/45">
          Every pillar scored 0–100 on how overdue it is against how well it performs. Freshly-posted pillars
          drop to the bottom — what&apos;s ranked at the top is what to reach for right now.
        </p>

        <div className="mt-4">
          <FilterBar />
        </div>

        {recentChains.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-white/35">In the feed this week</span>
            {recentChains.map((c) => (
              <span key={c.chain} className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-0.5 text-xs text-white/70">
                {c.label}
                <span className="ml-1 font-mono text-[10px] text-white/35">{c.count}</span>
              </span>
            ))}
            <span className="text-[11px] text-white/30">— ride an adjacent angle while these are warm</span>
          </div>
        )}

        <div className="mt-6 flex items-center justify-between">
          <Eyebrow>Post next</Eyebrow>
          <span className="font-mono text-[10px] text-white/30">
            {recommendations.length} pillars ranked · {dueCount} due or warming
          </span>
        </div>

        {recommendations.length === 0 ? (
          <p className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-6 text-center text-sm text-white/40">
            No pillars in this window.
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            {recommendations.map((rec, i) => (
              <RecCard
                key={rec.template}
                rec={rec}
                rank={i + 1}
                tlArticles={thoughtLeadership}
                broadEd={broadEducational}
                docPages={docPages}
                homepagePenalty={homepagePenalty}
                videos={videos}
                curriculum={curriculum}
              />
            ))}
          </div>
        )}

        {reAmplify.length > 0 && (
          <CollapsibleSection
            title="Past bangers — reference only"
            count={reAmplify.length}
            hint="numbers have moved on since — don't repost, just steal the shape"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {reAmplify.map((p) => (
                <a
                  key={p.id}
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  className="group flex gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3 transition hover:border-eco-lightblue/40 hover:bg-white/[0.05]"
                >
                  <Thumb src={pickThumb(p)} size={56} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-white/35">
                      <span className="text-eco-lightblue/80">{compact(p.impressions)} impr</span>
                      <span>·</span>
                      <span>{p.templateLabel}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-white/80">{p.text}</p>
                    <div className="mt-1.5 font-mono text-[10px] text-white/35">
                      {writtenDate(p.created_at)} · {daysAgo(p.daysAgo)}
                    </div>
                  </div>
                </a>
              ))}
            </div>
          </CollapsibleSection>
        )}
      </main>
    </div>
  );
}

// Build the draftable targets for a recommendation.
//
// The mode is now DECLARED on the pillar (TemplateDef.draftMode), not inferred.
// It used to be `if (rec.chains.length > 0)`, which meant a single incidental
// chain tag put Quote Card and Product Posts into chain-angle mode — Quote Card
// has two chain-tagged posts out of twenty, Product Posts one out of thirty-six,
// and in both cases the tag was a passing mention, not the subject.
function buildActions(
  rec: Recommendation,
  tlArticles: ArticleShelfRow[],
  broadEd: BroadEdBreakdown,
  docPages: DocShelfRow[],
  homepagePenalty: HomepagePenalty,
  videos: VideoShelfRow[],
  curriculum: CurriculumShelf,
): {
  mode: DraftMode;
  targets: Target[];
  products?: ProductGroup[];
  lanes?: LaneGroup[];
  docsMeta?: DocsMeta;
  videosMeta?: VideosMeta;
  broad?: BroadEdBreakdown;
  curriculum?: LaneGroup[];
  curriculumMeta?: CurriculumMeta;
} {
  const mode = TEMPLATE_BY_ID[rec.template].draftMode;

  if (mode === "docs") return { mode, targets: [], ...buildDocsLanes(docPages, homepagePenalty) };
  if (mode === "videos") return { mode, targets: [], ...buildVideoLanes(videos) };

  if (mode === "articles") {
    return { mode, targets: tlArticles.map((a) => articleTarget(a)) };
  }

  if (mode === "products") {
    // Two levels: pick the product, then the piece behind it (or an evergreen
    // angle with no article). Shapes ride along so the drafter can be told which
    // angle this product has gone cold on.
    const products: ProductGroup[] = rec.products.map((p) => ({
      key: `prod-${p.product}`,
      product: p.product,
      label: p.label,
      sublabel: `${compact(p.medianImpr)} median impr · ${p.count} post${p.count === 1 ? "" : "s"} · ${
        p.daysSince == null ? "never used" : `last ${daysAgo(p.daysSince)}`
      }`,
      readiness: p.readiness,
      shapes: p.shapes,
      targets: [
        ...p.articles.map((a) => articleTarget(a, p.product)),
        {
          key: `prod-${p.product}-evergreen`,
          label: `No article — evergreen ${p.label} angle`,
          sublabel: "Draft from the product itself, not a piece",
          product: p.product,
          angle: null,
          basePostText: null,
        },
      ],
    }));
    return { mode, targets: [], products };
  }

  if (mode === "discovery") {
    if (rec.template !== "broad_educational") return { mode, targets: [] };
    return {
      mode,
      targets: [],
      broad: broadEd,
      ...buildCurriculumLanes(curriculum),
    };
  }

  if (mode === "chains" && rec.chains.length > 0) {
    // Chains arrive coldest-first (by cross-pillar coverage), so the first
    // non-fresh row IS the best angle.
    const bestIdx = rec.chains.findIndex((c) => c.readiness !== "fresh");
    const base = rec.suggested?.link_title || rec.suggested?.text || null;
    const targets: Target[] = rec.chains.map((c, i) => {
      // Two clocks, and the gap between them is the point: this pillar last
      // announced the chain N days ago, but the audience last SAW it M days ago
      // via whichever pillar covered it. Only worth spelling out when they
      // differ — otherwise it's noise.
      const cover =
        c.coveredElsewhere && c.coverDaysSince != null
          ? `seen ${daysAgo(c.coverDaysSince)} via ${c.coverLabel}`
          : c.daysSince == null
            ? "never used"
            : `last ${daysAgo(c.daysSince)}`;
      return {
        key: `chain-${c.chain}`,
        label: c.label,
        sublabel: `${i === bestIdx ? "Best · " : ""}${compact(c.medianImpr)} median impr · announced ${
          c.daysSince == null ? "never" : daysAgo(c.daysSince)
        } · ${cover}`,
        chain: c.chain,
        basePostText: base,
        angle: `${c.label} angle`,
      };
    });
    return { mode, targets };
  }

  const base = rec.suggested?.link_title || rec.suggested?.text || null;
  return {
    mode: "generic",
    targets: [{ key: "generic", label: `Draft a fresh ${rec.label}`, basePostText: base, angle: null }],
  };
}

// One shelf row -> one draftable target. The sublabel is where the re-use story
// lives: how many times we've run it, how it did, and how long it has rested.
function articleTarget(a: ArticleShelfRow, product?: string): Target {
  const bits = [
    `used ${a.useCount}×`,
    `${compact(a.medianImpr)} median impr`,
    a.daysSinceLastUse == null ? "never used" : `last ${daysAgo(a.daysSinceLastUse)}`,
    a.publishedOn ? `published ${a.publishedOn}` : null,
  ].filter(Boolean);
  return {
    key: a.articleId == null ? "art-unmatched" : `art-${a.articleId}`,
    label: a.title.slice(0, 140),
    sublabel: `score ${a.score} · ${bits.join(" · ")}`,
    articleId: a.articleId,
    product: product ?? a.product ?? null,
    basePostText: a.dek || a.title,
    angle: null,
    href: a.canonicalUrl || a.xArticleUrl || a.posts[0]?.url || null,
    useCount: a.useCount,
    priorTexts: a.posts.slice(0, 6).map((p) => p.text),
  };
}

type DraftMode = "chains" | "products" | "articles" | "discovery" | "docs" | "videos" | "generic";

const ACTION_LABEL: Record<DraftMode, string> = {
  chains: "Pick a chain angle · draft copy",
  products: "Pick a product · draft copy",
  articles: "Pick an article · draft copy",
  discovery: "Discover sources · draft copy",
  docs: "Pick an audience + docs page · draft copy",
  videos: "Pick a clip · draft copy",
  generic: "Draft copy",
};

// ---------------------------------------------------------------------------
// Dev Doc Post — group the docs shelf by ICP.
//
// ICP and not docs section, deliberately. The section tree is how the docs site
// is organised for a reader who already knows what they want; the operator's
// question is "whose door haven't I knocked on", and docs.eco.com's own
// "Solutions for [persona]" pages make ICP a real axis rather than an imposed
// one. Reference-tier pages (endpoint tables, address registries) are dropped
// outright — they scored 0 and listing them would just make the shelf long.
// ---------------------------------------------------------------------------
function buildDocsLanes(
  pages: DocShelfRow[],
  penalty: HomepagePenalty,
): { lanes: LaneGroup[]; docsMeta: DocsMeta } {
  const postable = pages.filter((p) => p.tier !== "reference" && p.docPageId != null);

  const lanes: LaneGroup[] = ICP_DEFS.map((icp) => {
    const rows = postable.filter((p) => p.icp === icp.id).sort((a, b) => b.score - a.score);
    const used = rows.filter((r) => r.useCount > 0);
    const lastUsed = used
      .map((r) => r.daysSinceLastUse)
      .filter((d): d is number => d != null)
      .sort((a, b) => a - b)[0];
    return {
      key: `icp-${icp.id}`,
      label: icp.label,
      sublabel: [
        `${rows.length} page${rows.length === 1 ? "" : "s"}`,
        `${rows.filter((r) => r.useCount === 0).length} never linked`,
        lastUsed == null ? "never posted to this audience" : `last posted ${daysAgo(lastUsed)}`,
      ].join(" · "),
      hint: icp.brief,
      targets: rows.map((r) => docTarget(r)),
    };
  })
    .filter((l) => l.targets.length > 0)
    // Coldest door first: an audience with no posts at all outranks one served
    // last week, which is the whole point of grouping this way.
    .sort((a, b) => (b.targets[0]?.score ?? 0) - (a.targets[0]?.score ?? 0));

  return {
    lanes,
    docsMeta: {
      ...penalty,
      totalPages: postable.length,
      neverUsed: postable.filter((p) => p.useCount === 0).length,
    },
  };
}

function docTarget(r: DocShelfRow): Target & { score: number } {
  const badges: NonNullable<Target["badges"]> = [];
  if (r.tier === "hero") {
    badges.push({ label: "Hero", tone: "good", title: "A whole post can be built around this page." });
  }
  if (r.useCount === 0) {
    badges.push({ label: "Never linked", tone: "good", title: "No @eco post has ever driven to this page." });
  }
  return {
    key: `doc-${r.docPageId}`,
    label: r.title,
    sublabel: [
      r.section,
      r.useCount === 0 ? "never used" : `used ${r.useCount}×`,
      r.medianImpr != null ? `${compact(r.medianImpr)} median impr` : null,
      r.daysSinceLastUse != null ? `last ${daysAgo(r.daysSinceLastUse)}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    docPageId: r.docPageId,
    href: r.url,
    badges,
    useCount: r.useCount,
    // The drafter gets the full page body server-side; this is just the seed.
    basePostText: r.hook ?? r.blurb,
    angle: r.hook,
    priorTexts: r.posts.slice(0, 6).map((p) => p.text),
    score: r.score,
  };
}

// ---------------------------------------------------------------------------
// Analog curriculum — group the concept registry by Jay's four tiers.
//
// Tier and not ICP, unlike the docs shelf. The docs shelf groups by audience
// because its question is "whose door haven't I knocked on" among pages that
// all already exist. Here the question is different: the tiers ARE a difficulty
// and proximity ladder (Tier 1 is the direct analog, Tier 4 is context), and
// they came from Jay in that order. The ICPs ride along on every row instead.
//
// Every concept appears, taught or not. That is the entire point of a
// registry-first shelf — a concept with no post attached is the most valuable
// row on it, and would be invisible on any shelf derived from posts.
// ---------------------------------------------------------------------------
function buildCurriculumLanes(shelf: CurriculumShelf): {
  curriculum: LaneGroup[];
  curriculumMeta: CurriculumMeta;
} {
  const tiers: AnalogTier[] = [1, 2, 3, 4];
  const curriculum: LaneGroup[] = tiers
    .map((tier) => {
      const rows = shelf.rows.filter((r) => r.tier === tier).sort((a, b) => b.score - a.score);
      const never = rows.filter((r) => r.useCount === 0).length;
      return {
        key: `tier-${tier}`,
        label: ANALOG_TIER_LABEL[tier],
        sublabel: `${rows.length} concept${rows.length === 1 ? "" : "s"} · ${never} never taught`,
        hint: ANALOG_TIER_HINT[tier],
        targets: rows.map((r) => curriculumTarget(r)),
      };
    })
    .filter((l) => l.targets.length > 0)
    // Coldest, strongest tier first — same rule as the docs and video lanes.
    .sort((a, b) => (b.targets[0]?.score ?? 0) - (a.targets[0]?.score ?? 0));

  return { curriculum, curriculumMeta: shelf.meta };
}

function curriculumTarget(r: CurriculumRow): Target & { score: number } {
  const badges: NonNullable<Target["badges"]> = [];
  if (r.useCount === 0) {
    badges.push({ label: "Never taught", tone: "good", title: "No @eco post has ever explained this mechanism." });
  }
  if (r.breakStrength === 3) {
    badges.push({ label: "Sharp break", tone: "good", title: "The divergence from the analog is strong and differentiated." });
  }
  badges.push({
    label: r.side === "commercial" ? "Commercial" : "Technical",
    tone: "mute",
    title: `Written for the ${r.side} door: ${r.icpLabels.join(", ")}.`,
  });
  if (r.guardrail) {
    badges.push({ label: "Guardrail", tone: "warn", title: r.guardrail });
  }
  if (r.needsSources) {
    badges.push({
      label: "Needs sources",
      tone: "warn",
      title: "No verified source material — drafting is blocked until this concept has something citable behind it.",
    });
  }
  return {
    key: `analog-${r.analogId}`,
    label: r.label,
    sublabel: [
      `score ${r.score}`,
      r.icpLabels.join(", "),
      r.useCount === 0 ? "never taught" : `taught ${r.useCount}×`,
      r.mentionCount > 0 ? `${r.mentionCount} passing mention${r.mentionCount === 1 ? "" : "s"}` : null,
      r.sources.length ? `${r.sources.length} source${r.sources.length === 1 ? "" : "s"}` : "no sources",
      r.medianImpr != null ? `${compact(r.medianImpr)} median impr` : null,
      r.daysSinceLastUse != null ? `last ${daysAgo(r.daysSinceLastUse)}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    analogId: r.analogId,
    badges,
    useCount: r.useCount,
    // The break, surfaced on the row. The drafter gets the full parallel AND
    // break server-side; this is the half the operator needs to read to decide
    // whether the concept is worth a post today.
    note: r.breaksWhere,
    sources: r.sources.map((s) => ({
      title: s.title,
      url: s.url,
      publisher: s.publisher,
      kind: s.kind,
      seed: s.sourceOf === "seed",
    })),
    basePostText: null,
    angle: null,
    priorTexts: r.posts.slice(0, 6).map((p) => p.text),
    score: r.score,
  };
}

// ---------------------------------------------------------------------------
// Short-Form Video — group the clip library by series.
//
// Series and not ICP here: the operator's first question about a 300-clip
// library is "what kind of thing am I posting" (a Head of Product explainer, a
// CEO podcast cut, a 101), and the ICP rides along on each row. Clips the team
// filed under "Weak (Don't Use)" never appear at all.
// ---------------------------------------------------------------------------
function buildVideoLanes(videos: VideoShelfRow[]): { lanes: LaneGroup[]; videosMeta: VideosMeta } {
  const usable = videos.filter((v) => !v.doNotUse);

  const lanes: LaneGroup[] = SERIES_DEFS.map((s) => {
    const rows = usable.filter((v) => v.series === s.id).sort((a, b) => b.score - a.score);
    const never = rows.filter((v) => v.useCount === 0).length;
    return {
      key: `series-${s.id}`,
      label: s.label,
      sublabel: `${rows.length} clip${rows.length === 1 ? "" : "s"} · ${never} never posted`,
      hint: s.hint,
      // A lane of 200 clips is its own kind of unusable. The shelf is already
      // ranked, so the tail is the least useful part of it.
      targets: rows.slice(0, 40).map((v) => videoTarget(v)),
    };
  })
    .filter((l) => l.targets.length > 0)
    .sort((a, b) => (b.targets[0]?.score ?? 0) - (a.targets[0]?.score ?? 0));

  return {
    lanes,
    videosMeta: {
      total: usable.length,
      neverPosted: usable.filter((v) => v.useCount === 0).length,
      withFile: usable.filter((v) => v.hasFile).length,
      withTranscript: usable.filter((v) => v.transcript).length,
    },
  };
}

function videoTarget(v: VideoShelfRow): Target & { score: number } {
  const badges: NonNullable<Target["badges"]> = [];
  if (v.useCount === 0) {
    badges.push({ label: "Never posted", tone: "good", title: "This clip has never run on @eco." });
  }
  if (v.transcript) {
    badges.push({ label: "Transcript", tone: "good", title: "The drafter can quote the speaker directly." });
  }
  if (v.hasFile) {
    badges.push({ label: "File", tone: "mute", title: `In Dropbox: ${v.dropboxPath ?? "delivery folder"}` });
  }
  if (!v.ytVideoId) {
    badges.push({ label: "Not on channel", tone: "warn", title: "Exists as a file only — never uploaded to YouTube." });
  }
  return {
    key: `vid-${v.id}`,
    label: v.title,
    sublabel: [
      v.topic,
      v.speakerLabel,
      v.durationSec != null ? `${v.durationSec}s` : null,
      v.ytViews != null ? `${compact(v.ytViews)} YT views` : null,
      v.useCount === 0 ? "never posted" : `posted ${v.useCount}×`,
    ]
      .filter(Boolean)
      .join(" · "),
    videoId: v.id,
    href: v.ytUrl,
    thumbUrl: v.ytThumbUrl,
    badges,
    useCount: v.useCount,
    basePostText: v.hook ?? v.description,
    angle: v.hook,
    priorTexts: v.posts.slice(0, 6).map((p) => p.text),
    score: v.score,
  };
}

// Collapsed-row summary for a pillar card: how much is on its shelf, and
// whether that shelf is itself split into accordions.
function shelfSummary(
  mode: DraftMode,
  targets: Target[],
  products: ProductGroup[] | undefined,
  lanes: LaneGroup[] | undefined,
  curriculumMeta?: CurriculumMeta,
): { count: string | undefined; nested: boolean } {
  const prods = products ?? [];
  const groups = lanes ?? [];
  if (mode === "docs" || mode === "videos") {
    const total = groups.reduce((n, l) => n + l.targets.length, 0);
    const unit = mode === "docs" ? "pages" : "clips";
    if (groups.length === 0) return { count: "shelf empty", nested: false };
    return { count: `${groups.length} lanes \u00b7 ${total} ${unit}`, nested: true };
  }
  if (mode === "products") {
    const total = prods.reduce((n, p) => n + p.targets.length, 0);
    if (prods.length === 0) return { count: "no coverage", nested: false };
    return { count: `${prods.length} products \u00b7 ${total} to draft from`, nested: true };
  }
  if (mode === "discovery") {
    // Broad Educational's collapsed row should lead with the coverage gap, not
    // with "run discovery" — the untaught count is the number that should make
    // someone open the card.
    if (curriculumMeta) {
      return {
        count: `${curriculumMeta.neverTaught}/${curriculumMeta.totalConcepts} concepts untaught \u00b7 + market news`,
        nested: true,
      };
    }
    return { count: targets.length ? `${targets.length} sources` : "run discovery", nested: false };
  }
  const noun = mode === "chains" ? "angles" : mode === "articles" ? "articles" : "to draft from";
  return { count: targets.length ? `${targets.length} ${noun}` : "nothing queued", nested: false };
}

function RecCard({
  rec,
  rank,
  tlArticles,
  broadEd,
  docPages,
  homepagePenalty,
  videos,
  curriculum,
}: {
  rec: Recommendation;
  rank: number;
  tlArticles: ArticleShelfRow[];
  broadEd: BroadEdBreakdown;
  docPages: DocShelfRow[];
  homepagePenalty: HomepagePenalty;
  videos: VideoShelfRow[];
  curriculum: CurriculumShelf;
}) {
  const top = rank === 1 && rec.score > 0;
  const lastType = mediaLabel(rec.lastMediaType);
  const {
    mode,
    targets,
    products,
    lanes,
    docsMeta,
    videosMeta,
    broad,
    curriculum: currLanes,
    curriculumMeta,
  } = buildActions(rec, tlArticles, broadEd, docPages, homepagePenalty, videos, curriculum);

  // Everything above the break line — the at-a-glance read, always visible.
  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-white/30">#{rank}</span>
          <h3 className="text-base font-medium text-white/90">{rec.label}</h3>
          {readinessBadge(rec.readiness)}
          {rec.easyWin && (
            <Tooltip text="Low-effort format — a quick post that doesn't need a big lift. Easy rep.">
              <span className="cursor-help rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">Easy win</span>
            </Tooltip>
          )}
        </div>
        <div className="mt-1 text-sm text-white/50">
          Last posted <span className="text-white/70">{writtenDate(rec.lastPosted)}</span>
          {lastType && <span className="text-white/40"> ({lastType})</span>}
          {rec.daysSince != null && <span className="text-white/40"> · {daysAgo(rec.daysSince)}</span>}
        </div>
        {rec.scoreReasons.length > 0 && (
          <ul className="mt-2 space-y-0.5">
            {rec.scoreReasons.map((why, i) => (
              <li key={i} className="text-xs text-white/55">
                <span className="mr-1.5 text-white/25">›</span>
                {why}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-none items-start gap-4">
        <Tooltip text={METRIC_DEFS.score}>
          <div className={`flex h-14 w-14 cursor-help flex-col items-center justify-center rounded-xl border ${scoreTone(rec.score)}`}>
            <span className="text-lg font-semibold leading-none tabular-nums">{rec.score}</span>
            <span className="mt-0.5 font-mono text-[8px] uppercase tracking-wider opacity-70">score</span>
          </div>
        </Tooltip>
        <div className="flex gap-4 text-right">
          <Metric label="Median impr" value={compact(rec.medianImpr)} def={METRIC_DEFS.medianImpr} />
          <Metric label="Avg eng" value={rec.avgEngRate == null ? "—" : `${(rec.avgEngRate * 100).toFixed(1)}%`} def={METRIC_DEFS.avgEng} />
          <Metric label="Posts 90d" value={String(rec.count90)} def={METRIC_DEFS.count90} />
        </div>
      </div>
    </div>
  );

  // What is behind the click, said out loud on the collapsed row. A first-time
  // reader shouldn't have to open a pillar to learn whether it has anything in
  // it — or whether it nests another level of accordions inside.
  const shelf = shelfSummary(mode, targets, products, lanes, curriculumMeta);

  return (
    <ExpandableCard
      header={header}
      highlight={top}
      actionLabel={curriculumMeta ? "Teach a concept or discover sources · draft copy" : ACTION_LABEL[mode]}
      count={shelf.count}
      nested={shelf.nested}
      defaultOpen={rank === 1}
    >
      <RecActions
        template={rec.template}
        score={rec.score}
        mode={mode}
        targets={targets}
        products={products}
        lanes={lanes}
        docsMeta={docsMeta}
        videosMeta={videosMeta}
        broad={broad}
        curriculum={currLanes}
        curriculumMeta={curriculumMeta}
        recDrivenCount={rec.recDrivenCount}
        recDrivenVsBaseline={rec.recDrivenVsBaseline}
      />
    </ExpandableCard>
  );
}

function Metric({ label, value, def }: { label: string; value: string; def: string }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-white/30">
        <Tooltip text={def} underline>
          {label}
        </Tooltip>
      </div>
      <div className="mt-0.5 text-sm font-medium tabular-nums text-white/85">{value}</div>
    </div>
  );
}
