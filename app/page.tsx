import {
  getInsights,
  type Recommendation,
  type Readiness,
  type ArticleShelfRow,
  type BroadEdBreakdown,
} from "@/lib/stats";
import { getReviewCount } from "@/lib/queries";
import { Sidebar } from "@/app/components/Sidebar";
import { FilterBar } from "@/app/components/FilterBar";
import { parseFilter } from "@/lib/filter";
import { Eyebrow, Badge, Thumb, Tooltip } from "@/app/components/ui";
import { writtenDate, daysAgo, compact } from "@/lib/format";
import { pickThumb } from "@/lib/media";
import { METRIC_DEFS } from "@/lib/metricDefs";
import { RecActions, type Target, type ProductGroup } from "@/app/components/RecActions";
import { TEMPLATE_BY_ID } from "@/lib/taxonomy";
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
  const [{ recommendations, reAmplify, recentChains, thoughtLeadership, broadEducational }, reviewCount] =
    await Promise.all([getInsights(filter), getReviewCount()]);

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
              <RecCard key={rec.template} rec={rec} rank={i + 1} tlArticles={thoughtLeadership} broadEd={broadEducational} />
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
): { mode: DraftMode; targets: Target[]; products?: ProductGroup[]; broad?: BroadEdBreakdown } {
  const mode = TEMPLATE_BY_ID[rec.template].draftMode;

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
    return { mode, targets: [], broad: rec.template === "broad_educational" ? broadEd : undefined };
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

type DraftMode = "chains" | "products" | "articles" | "discovery" | "generic";

const ACTION_LABEL: Record<DraftMode, string> = {
  chains: "Pick a chain angle · draft copy",
  products: "Pick a product · draft copy",
  articles: "Pick an article · draft copy",
  discovery: "Discover sources · draft copy",
  generic: "Draft copy",
};

function RecCard({
  rec,
  rank,
  tlArticles,
  broadEd,
}: {
  rec: Recommendation;
  rank: number;
  tlArticles: ArticleShelfRow[];
  broadEd: BroadEdBreakdown;
}) {
  const top = rank === 1 && rec.score > 0;
  const lastType = mediaLabel(rec.lastMediaType);
  const { mode, targets, products, broad } = buildActions(rec, tlArticles, broadEd);

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

  return (
    <ExpandableCard header={header} highlight={top} actionLabel={ACTION_LABEL[mode]}>
      <RecActions
        template={rec.template}
        score={rec.score}
        mode={mode}
        targets={targets}
        products={products}
        broad={broad}
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
