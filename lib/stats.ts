import { sql } from "./db.ts";
import { TEMPLATE_BY_ID, type Template } from "./taxonomy.ts";
import { chainLabel, entityLabel } from "./dimensions.ts";
import { productLabel, SHAPE_BY_ID, PRODUCT_POST_SHAPES } from "./products.ts";
import { getArticleShelf, type ArticleShelfRow } from "./articles.ts";
import { getDocShelf, getHomepagePenalty, type DocShelfRow, type HomepagePenalty } from "./docs.ts";
import { getVideoShelf, type VideoShelfRow } from "./videos.ts";
import { getCurriculumShelf, type CurriculumShelf } from "./curriculum.ts";
import { getArticleCoverage, pairingVerdict, type PairableTarget } from "./articleCoverage.ts";
import { getTemplateTrends, trendVerdict, type TemplateTrend, type TrendFlag } from "./trend.ts";
import { getDmvLanes, dmvLaneReasons, coldestLane, type DmvLane } from "./dmvLanes.ts";
import { getAngleBank, type AngleBank } from "./angleBank.ts";

// Amplified filter: 'all' | 'organic' | 'amplified'. Mixing paid-amplified and
// organic posts corrupts a template's baselines, so every stat is filterable.
export type AmpFilter = "all" | "organic" | "amplified";

export interface StatFilter {
  amplified: AmpFilter;
  since: string | null; // ISO date lower bound, or null for all-time
}

function ampFlags(a: AmpFilter): { includeAll: boolean; wantAmplified: boolean } {
  return { includeAll: a === "all", wantAmplified: a === "amplified" };
}

export interface TemplateStat {
  template: Template;
  label: string;
  staleDays: number;
  lastPosted: string | null;
  daysSince: number | null;
  lastMediaType: string | null; // media_type of the most-recent post (article/video/photo/…)
  count30: number;
  count90: number;
  countTotal: number;
  avgImpr: number | null;
  medianImpr: number | null;
  avgEngRate: number | null; // engagements ÷ impressions, averaged over posts
}

// One row per template. Stats computed over each post's LATEST metric snapshot.
// Pure reposts are already excluded at ingest; self-replies are included but
// marked (callers can filter). "Last posted" is derived (MAX created_at), never
// stored.
export async function getOverview(filter: StatFilter): Promise<TemplateStat[]> {
  const { includeAll, wantAmplified } = ampFlags(filter.amplified);
  const rows = await sql<Omit<TemplateStat, "label" | "staleDays">>`
    WITH latest AS (
      SELECT p.id, p.template, p.created_at, p.media_type,
             s.impressions, s.likes, s.replies, s.retweets, s.quotes, s.bookmarks
      FROM posts p
      LEFT JOIN LATERAL (
        SELECT * FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
      ) s ON true
      WHERE p.template IS NOT NULL
        AND p.is_reply = false
        AND (${includeAll} OR p.amplified = ${wantAmplified})
        AND (${filter.since}::timestamptz IS NULL OR p.created_at >= ${filter.since}::timestamptz)
    )
    SELECT
      template,
      MAX(created_at) AS "lastPosted",
      EXTRACT(DAY FROM now() - MAX(created_at))::int AS "daysSince",
      (array_agg(media_type ORDER BY created_at DESC))[1] AS "lastMediaType",
      COUNT(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS "count30",
      COUNT(*) FILTER (WHERE created_at > now() - interval '90 days')::int AS "count90",
      COUNT(*)::int AS "countTotal",
      ROUND(AVG(impressions))::int AS "avgImpr",
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY impressions))::int AS "medianImpr",
      AVG(CASE WHEN impressions > 0
            THEN (likes + replies + retweets + quotes + bookmarks)::float / impressions END) AS "avgEngRate"
    FROM latest
    GROUP BY template
  `;

  const byId = new Map(rows.map((r) => [r.template, r]));
  // Return every template (including ones with zero posts) so the "whole bag"
  // is always visible, in taxonomy order, 'other' last.
  return Object.values(TEMPLATE_BY_ID)
    .filter((d) => d.id !== "other")
    .concat(TEMPLATE_BY_ID.other)
    .map((d) => {
      const r = byId.get(d.id);
      return {
        template: d.id,
        label: d.label,
        staleDays: d.staleDays,
        lastPosted: r?.lastPosted ?? null,
        daysSince: r?.daysSince ?? null,
        lastMediaType: r?.lastMediaType ?? null,
        count30: r?.count30 ?? 0,
        count90: r?.count90 ?? 0,
        countTotal: r?.countTotal ?? 0,
        avgImpr: r?.avgImpr ?? null,
        medianImpr: r?.medianImpr ?? null,
        avgEngRate: r?.avgEngRate ?? null,
      };
    });
}

export interface TopPost {
  id: string;
  url: string;
  created_at: string;
  text: string;
  template: Template | null;
  media_type: string;
  media_urls: string[];
  preview_image_url: string | null;
  link_image_url: string | null;
  quoted_image_url: string | null;
  impressions: number | null;
  likes: number | null;
  replies: number | null;
  bookmarks: number | null;
  amplified: boolean;
}

export interface WeeklyPoint {
  week: string; // ISO date (Monday)
  count: number;
}

export interface TemplateDetail {
  stat: TemplateStat;
  posts: TopPost[];
  weekly: WeeklyPoint[];
}

// ---------------------------------------------------------------------------
// Insights — the "what do I post today?" tab. Answers it in one screen: which
// content pillars are DUE (stale vs their cadence) and still perform, and —
// within a chain-oriented pillar — which chain angle is the best untapped one
// ("you just did Solana; the next best is Arbitrum"). Plus a list of past
// bangers old enough to re-amplify.
// ---------------------------------------------------------------------------

export type Readiness = "due" | "soon" | "fresh" | "never";

// Days-since vs the template's cadence → a readiness bucket. Mirrors the
// overview's staleness coloring so the two views agree.
function readinessOf(daysSince: number | null, staleDays: number): Readiness {
  if (daysSince == null) return "never";
  if (daysSince > staleDays) return "due";
  if (daysSince > staleDays * 0.6) return "soon";
  return "fresh";
}

// Recommendation score: performance × how overdue. Freshly-posted pillars score
// 0 (don't recommend what you just did); overdue pillars are boosted up to 2×.
function recencyWeight(daysSince: number | null, staleDays: number): number {
  if (daysSince == null) return 0; // never posted → unknown performance, don't rank on it
  if (daysSince <= staleDays * 0.6) return 0; // fresh — skip
  if (daysSince <= staleDays) return 0.5; // warming
  return 1 + Math.min((daysSince - staleDays) / staleDays, 1); // overdue: 1..2
}

// "18d" / "today". Local for the same reason as short() — reason strings are
// built server-side and stats.ts stays free of UI imports.
function agoText(days: number | null): string {
  if (days == null) return "never";
  if (days <= 0) return "today";
  return `${days}d ago`;
}

// Number formatter for reason strings (12.3k). Local so stats.ts stays free of
// UI imports.
function short(n: number | null): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1000) return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  return String(Math.round(n));
}

// Turn the raw perf×overdue signals into a bounded 0..100 priority the operator
// can actually read, plus the plain-English drivers behind it. Jay's ask: "does
// this engine know it's a 90 out of 100 — and I should understand why."
//   overdue component (0..1): how far past cadence we are (fresh/never → 0).
//   perf component   (0..1): this pillar's baseline impressions vs the other
//                            pillars (a percentile), so a strong pillar that's
//                            also overdue outranks a weak one that's merely late.
// A fresh/never pillar scores 0 and drops to the "resting" list, same split as
// before — we just make the surviving scores legible and defensible.
function scoreParts(args: {
  readiness: Readiness;
  daysSince: number | null;
  staleDays: number;
  perfPct: number | null; // 0..1 percentile of baseline impressions across pillars
  baselineImpr: number | null;
  discounted: boolean;
}): { score: number; reasons: string[] } {
  const { readiness, daysSince, staleDays, perfPct, baselineImpr, discounted } = args;
  const recW = recencyWeight(daysSince, staleDays);
  if (recW === 0) return { score: 0, reasons: [] };

  const overdueComponent = Math.min(recW / 2, 1); // 0.25 (warming) .. 1 (very overdue)
  const perfComponent = perfPct ?? 0.5; // unknown perf → neutral
  const score = Math.max(1, Math.round(100 * (0.55 * overdueComponent + 0.45 * perfComponent)));

  const reasons: string[] = [];
  if (readiness === "due" && daysSince != null) {
    reasons.push(`Overdue by ${daysSince - staleDays}d past its ${staleDays}d cadence`);
  } else if (readiness === "soon" && daysSince != null) {
    reasons.push(`Warming — ${daysSince}d of ${staleDays}d cadence used`);
  }
  if (perfPct != null && baselineImpr != null) {
    if (perfPct >= 0.75) reasons.push(`Top performer — ${short(baselineImpr)} median impressions`);
    else if (perfPct >= 0.5) reasons.push(`Above-median performer (${short(baselineImpr)} median)`);
    else reasons.push(`Below-median performer (${short(baselineImpr)} median)`);
  }
  if (discounted) reasons.push(`Baseline excludes amplified & launch posts`);
  return { score, reasons };
}

// One chain angle for a chain-oriented pillar. Two clocks live on this row and
// they answer different questions:
//
//   count / daysSince / medianImpr  — this chain INSIDE this pillar. How often
//     we've announced it and how those announcements performed.
//   cover* — this chain across EVERY pillar. When the subject was last in front
//     of the audience at all, and which pillar put it there.
//
// `readiness` is driven by the COVERAGE clock, not the pillar clock. A chain a
// data-motion visual covered last week is not a cold angle just because the
// integration pillar hasn't touched it since July.
export interface ChainAngle {
  chain: string;
  label: string;
  count: number;
  lastPosted: string | null;
  daysSince: number | null;
  medianImpr: number | null;
  avgImpr: number | null;
  readiness: Readiness;
  coverCount: number; // posts touching this chain in ANY pillar
  coverDaysSince: number | null;
  coverTemplate: Template | null; // pillar whose post touched it most recently
  coverLabel: string | null; // that pillar's display label
  coveredElsewhere: boolean; // the most recent touch came from a DIFFERENT pillar
  // --- The integration article behind this chain, when one exists ------------
  // Chain targets used to carry a chain id and nothing else, so the drafter had
  // no source material and invented its own facts (and its own link). These
  // three carry the piece through to lib/generateCopy.ts.
  articleId: number | null;
  articleTitle: string | null;
  /** The URL a draft must link to. An @eco status url unfurls the X article
   *  card in the composer; the blog url is the fallback for chains announced
   *  before Eco published X articles. */
  shareUrl: string | null;
  /** Posts that already used this article — handed over as "angles spent". */
  priorTexts: string[];
}

// A concrete, already-published post the operator can put back out for this
// pillar — the single highest-impression @eco post in the pillar within the
// freshness window (see SUGGEST_MAX_AGE_DAYS). This is what makes a pillar
// recommendation prescriptive ("post THIS article", not just "post something
// thought-leadership-y"). For thought_leadership these are the CEO op-eds and
// reposted team-member articles the account has run.
export interface SuggestedPost {
  id: string;
  url: string;
  text: string;
  created_at: string;
  daysAgo: number;
  impressions: number | null;
  media_type: string;
  media_urls: string[];
  preview_image_url: string | null;
  link_image_url: string | null;
  quoted_image_url: string | null;
  link_title: string | null;
}

export interface Recommendation extends TemplateStat {
  readiness: Readiness;
  score: number; // 0..100 priority (0 = fresh/never, don't recommend now)
  scoreReasons: string[]; // human-readable drivers behind the score ("why")
  baselineImpr: number | null; // clean performance baseline (organic, launch post excluded)
  discounted: boolean; // true when the raw median was inflated by amplified/launch posts
  trendFlag: TrendFlag; // last-5 vs prior-5 direction ('insufficient' until 7 posts)
  trendImprPct: number | null; // signed % change in median impressions
  easyWin: boolean; // low-effort format worth a quick post (quote card, motion visual)
  chains: ChainAngle[]; // best-performing chain angles — only meaningful for the chain pillar
  products: ProductAngle[]; // Eco products this pillar has covered, ranked
  suggested: SuggestedPost | null; // the specific proven post to re-run, ≤3mo old
}

export interface ReAmplifyPost {
  id: string;
  url: string;
  created_at: string;
  daysAgo: number;
  text: string;
  template: Template;
  templateLabel: string;
  media_type: string;
  media_urls: string[];
  preview_image_url: string | null;
  link_image_url: string | null;
  quoted_image_url: string | null;
  chains: string[];
  entities: string[];
  impressions: number | null;
}

export interface RecentChain {
  chain: string;
  label: string;
  count: number;
}

// Thought Leadership and Product Posts both sit on ARTICLES, not chains — and
// crucially on the article, not the post. @eco publishes a piece once and then
// re-amplifies it four or five times over the following weeks; the old shelf
// listed each of those as a separate article, which buried the one number that
// matters when you're picking what to run: how many times have we used this
// already, and how did those runs do? See lib/articles.ts.
export type { ArticleShelfRow } from "./articles.ts";

// How a pillar's PRODUCT coverage looks — the axis Product Posts actually
// rotates on. (34 of 36 posts in that pillar carry no chain tag at all, which is
// why chain angles were landing on nothing there.)
export interface ShapeUse {
  shape: string;
  label: string;
  count: number;
  daysSince: number | null;
  medianImpr: number | null;
}

export interface ProductAngle {
  product: string;
  label: string;
  count: number;
  lastPosted: string | null;
  daysSince: number | null;
  medianImpr: number | null;
  readiness: Readiness;
  shapes: ShapeUse[]; // every shape, used or not, so cold ones are visible
  articles: ArticleShelfRow[]; // this product's pieces, most re-runnable first
}

// Broad-educational never reshares the same piece, so instead of "post this
// again" we show what WORKED as an approach: content-type mix, the entities that
// landed, and a few reference angles. The actual sourcing comes from Discover.
export interface BroadEdType {
  mediaType: string;
  count: number;
  medianImpr: number | null;
}
export interface BroadEdEntity {
  entity: string;
  label: string;
  count: number;
  medianImpr: number | null;
}
export interface BroadEdAngle {
  id: string;
  url: string;
  title: string;
  impressions: number | null;
  created_at: string;
  mediaType: string;
  entities: string[];
}
export interface BroadEdBreakdown {
  byType: BroadEdType[];
  topEntities: BroadEdEntity[];
  topAngles: BroadEdAngle[];
}

export interface Insights {
  recommendations: Recommendation[];
  reAmplify: ReAmplifyPost[];
  recentChains: RecentChain[]; // chains that showed up in the feed in the last few days
  thoughtLeadership: ArticleShelfRow[]; // TL shelf, ONE ROW PER ARTICLE with its aggregate
  broadEducational: BroadEdBreakdown; // what has worked in broad-educational, by approach
  // Registry-first shelves. Unlike the article shelf these are NOT derived from
  // posts, so their most valuable rows are the ones with no post attached: docs
  // pages we have never linked, clips we have never run.
  docPages: DocShelfRow[];
  homepagePenalty: HomepagePenalty;
  videos: VideoShelfRow[];
  // The curriculum shelf. Same registry-first shape as docs/videos, and for the
  // same reason: its most valuable rows are the concepts with no post attached.
  curriculum: CurriculumShelf;
  // The three Data Motion Visual lanes (lib/dmvLanes.ts).
  dmvLanes: DmvLane[];
  // Broad Educational's angle bank — what replaced its drafter (lib/angleBank.ts).
  angleBank: AngleBank;
}

export type { DmvLane, DmvLaneId } from "./dmvLanes.ts";
export type { AngleBank, EducationAngle } from "./angleBank.ts";
export type { DocShelfRow, HomepagePenalty } from "./docs.ts";
export type { CurriculumRow, CurriculumMeta, CurriculumShelf } from "./curriculum.ts";
export type { VideoShelfRow } from "./videos.ts";

// Low-effort, high-frequency formats Jay flags as "easy wins" — a quick post
// that doesn't need a big lift ("post a quote card, that'll take 10 minutes,
// the last 10 ripped").
const EASY_WIN_TEMPLATES = new Set<Template>(["quote_card", "data_motion_visual"]);

// How recent a post has to be to count as "in the feed right now" for the
// context-aware nudge.
const RECENT_CONTEXT_DAYS = 4;

// How old a post must be before re-amplifying it makes sense.
const REAMPLIFY_MIN_AGE_DAYS = 45;

// A recommendation's concrete "post this" suggestion must be recent — Robert's
// rule: never push a thought-leadership article more than 3 months old. Applies
// to every pillar's suggested post, not just thought_leadership.
const SUGGEST_MAX_AGE_DAYS = 90;

export async function getInsights(filter: StatFilter): Promise<Insights> {
  const { includeAll, wantAmplified } = ampFlags(filter.amplified);
  const overview = await getOverview(filter);

  // Per (template, chain) angle stats — from each post's latest snapshot. Posts
  // with no chain simply contribute no rows here (unnest of an empty array).
  const angleRows = await sql<{
    template: Template;
    chain: string;
    count: number;
    lastPosted: string | null;
    daysSince: number | null;
    medianImpr: number | null;
    avgImpr: number | null;
  }>`
    WITH latest AS (
      SELECT p.id, p.template, p.created_at, p.chains, s.impressions
      FROM posts p
      LEFT JOIN LATERAL (
        SELECT * FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
      ) s ON true
      WHERE p.template IS NOT NULL AND p.template <> 'other'
        AND p.is_reply = false
        AND (${includeAll} OR p.amplified = ${wantAmplified})
        AND (${filter.since}::timestamptz IS NULL OR p.created_at >= ${filter.since}::timestamptz)
    ),
    exploded AS (
      SELECT template, created_at, impressions, unnest(chains) AS chain FROM latest
    )
    SELECT template, chain,
      COUNT(*)::int AS count,
      MAX(created_at) AS "lastPosted",
      EXTRACT(DAY FROM now() - MAX(created_at))::int AS "daysSince",
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY impressions))::int AS "medianImpr",
      ROUND(AVG(impressions))::int AS "avgImpr"
    FROM exploded
    GROUP BY template, chain
    ORDER BY "medianImpr" DESC NULLS LAST
  `;

  // Cross-pillar chain COVERAGE — grouped by chain alone, not by (template,
  // chain). The angle table above can only see a chain through one pillar's
  // window, which is how "New Chain Integrations — 27d stale" ended up top of
  // the board while TRON and Robinhood had both been amplified in the previous
  // three weeks as data-motion visuals quoting their integration articles. The
  // pillar was stale; the subject was not, and nothing in the query could tell
  // the difference.
  //
  // Returns, per chain: how many posts touched it anywhere, when the most recent
  // one landed, and which pillar it belonged to.
  const coverageRows = await sql<{
    chain: string;
    count: number;
    lastPosted: string | null;
    daysSince: number | null;
    lastTemplate: Template;
  }>`
    WITH scoped AS (
      SELECT p.template, p.created_at, p.chains
      FROM posts p
      WHERE p.template IS NOT NULL AND p.template <> 'other'
        AND p.is_reply = false
        AND (${includeAll} OR p.amplified = ${wantAmplified})
        AND (${filter.since}::timestamptz IS NULL OR p.created_at >= ${filter.since}::timestamptz)
    ),
    exploded AS (
      SELECT template, created_at, unnest(chains) AS chain FROM scoped
    ),
    ranked AS (
      SELECT chain, template, created_at,
             ROW_NUMBER() OVER (PARTITION BY chain ORDER BY created_at DESC) AS rn,
             COUNT(*)    OVER (PARTITION BY chain) AS n,
             MAX(created_at) OVER (PARTITION BY chain) AS last_posted
      FROM exploded
    )
    SELECT chain,
           n::int AS count,
           last_posted AS "lastPosted",
           EXTRACT(DAY FROM now() - last_posted)::int AS "daysSince",
           template AS "lastTemplate"
    FROM ranked WHERE rn = 1
  `;
  const coverageByChain = new Map(coverageRows.map((r) => [r.chain, r]));

  // The integration article per chain, plus every post that already ran it.
  // Without this the chain pillar was the one draft mode with no source: it got
  // a chain name and the positioning brief, and the model filled the gap by
  // reconstructing plausible-sounding Eco copy. Six chains have a piece; the
  // other twenty in CHAIN_LABELS have none, and the UI has to say so rather
  // than silently offering an unsourced draft.
  const chainArticleRows = await sql<{
    chain: string;
    articleId: number;
    title: string;
    shareUrl: string | null;
    priorTexts: string[];
  }>`
    SELECT a.chain,
           a.id::int                   AS "articleId",
           a.title,
           a.share_url                 AS "shareUrl",
           COALESCE(
             (SELECT array_agg(p.text ORDER BY p.created_at DESC)
              FROM posts p
              WHERE p.article_id = a.id AND p.is_reply = false AND p.text IS NOT NULL),
             '{}'
           )                           AS "priorTexts"
    FROM articles a
    WHERE a.chain IS NOT NULL
  `;
  const articleByChain = new Map(chainArticleRows.map((r) => [r.chain, r]));

  const anglesByTemplate = new Map<Template, ChainAngle[]>();
  for (const a of angleRows) {
    const def = TEMPLATE_BY_ID[a.template];
    const list = anglesByTemplate.get(a.template) ?? [];
    // Coverage is a superset of the pillar's own posts, so it can only ever be
    // as recent or more recent. Falling back to the pillar clock keeps the row
    // sane if a chain somehow has no coverage row.
    const cov = coverageByChain.get(a.chain);
    const art = articleByChain.get(a.chain);
    const coverDaysSince = cov?.daysSince ?? a.daysSince;
    list.push({
      chain: a.chain,
      label: chainLabel(a.chain),
      count: a.count,
      lastPosted: a.lastPosted,
      daysSince: a.daysSince,
      medianImpr: a.medianImpr,
      avgImpr: a.avgImpr,
      readiness: readinessOf(coverDaysSince, def.staleDays),
      coverCount: cov?.count ?? a.count,
      coverDaysSince,
      coverTemplate: cov?.lastTemplate ?? null,
      coverLabel: cov ? TEMPLATE_BY_ID[cov.lastTemplate].label : null,
      coveredElsewhere: cov != null && cov.lastTemplate !== a.template,
      articleId: art?.articleId ?? null,
      articleTitle: art?.title ?? null,
      shareUrl: art?.shareUrl ?? null,
      priorTexts: (art?.priorTexts ?? []).slice(0, 6),
    });
    anglesByTemplate.set(a.template, list);
  }
  // Coldest-first: an angle the audience hasn't seen in a while is the one worth
  // reaching for. Ties broken by how well the angle performs in this pillar, so
  // among equally-rested chains the strongest still floats up.
  for (const list of anglesByTemplate.values()) {
    list.sort(
      (a, b) => (b.coverDaysSince ?? -1) - (a.coverDaysSince ?? -1) || (b.medianImpr ?? 0) - (a.medianImpr ?? 0),
    );
  }

  // Per (template, product) angle stats — the Product Posts equivalent of the
  // chain-angle table. Posts with no product contribute no rows (unnest of an
  // empty array), so a pillar that isn't about products simply gets none.
  const productRows = await sql<{
    template: Template;
    product: string;
    count: number;
    lastPosted: string | null;
    daysSince: number | null;
    medianImpr: number | null;
  }>`
    WITH latest AS (
      SELECT p.id, p.template, p.created_at, p.products, s.impressions
      FROM posts p
      LEFT JOIN LATERAL (
        SELECT * FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
      ) s ON true
      WHERE p.template IS NOT NULL AND p.template <> 'other'
        AND p.is_reply = false
        AND (${includeAll} OR p.amplified = ${wantAmplified})
        AND (${filter.since}::timestamptz IS NULL OR p.created_at >= ${filter.since}::timestamptz)
    ),
    exploded AS (
      SELECT template, created_at, impressions, unnest(products) AS product FROM latest
    )
    SELECT template, product,
      COUNT(*)::int AS count,
      MAX(created_at) AS "lastPosted",
      EXTRACT(DAY FROM now() - MAX(created_at))::int AS "daysSince",
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY impressions))::int AS "medianImpr"
    FROM exploded
    GROUP BY template, product
    ORDER BY "medianImpr" DESC NULLS LAST
  `;

  // Shape usage per (template, product). Feeds the "you have run problem →
  // mechanism five times straight for this product" nudge, so the drafter can
  // offer an angle the pillar has actually gone cold on.
  const shapeRows = await sql<{
    template: Template;
    product: string;
    shape: string;
    count: number;
    daysSince: number | null;
    medianImpr: number | null;
  }>`
    WITH latest AS (
      SELECT p.template, p.created_at, p.products, p.shape, s.impressions
      FROM posts p
      LEFT JOIN LATERAL (
        SELECT * FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
      ) s ON true
      WHERE p.template IS NOT NULL AND p.shape IS NOT NULL
        AND p.is_reply = false
        AND (${includeAll} OR p.amplified = ${wantAmplified})
        AND (${filter.since}::timestamptz IS NULL OR p.created_at >= ${filter.since}::timestamptz)
    ),
    exploded AS (
      SELECT template, created_at, impressions, shape, unnest(products) AS product FROM latest
    )
    SELECT template, product, shape,
      COUNT(*)::int AS count,
      EXTRACT(DAY FROM now() - MAX(created_at))::int AS "daysSince",
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY impressions))::int AS "medianImpr"
    FROM exploded
    GROUP BY template, product, shape
  `;

  // Product angles, indexed by pillar, each carrying its shape mix. Articles are
  // attached later, once the shelves have been read.
  const shapesByKey = new Map<string, ShapeUse[]>();
  for (const r of shapeRows) {
    const key = `${r.template}|${r.product}`;
    const list = shapesByKey.get(key) ?? [];
    list.push({
      shape: r.shape,
      label: SHAPE_BY_ID[r.shape]?.label ?? r.shape,
      count: r.count,
      daysSince: r.daysSince,
      medianImpr: r.medianImpr,
    });
    shapesByKey.set(key, list);
  }

  const productsByTemplate = new Map<Template, ProductAngle[]>();
  for (const r of productRows) {
    const def = TEMPLATE_BY_ID[r.template];
    const used = shapesByKey.get(`${r.template}|${r.product}`) ?? [];
    const usedById = new Map(used.map((u) => [u.shape, u]));
    // Every shape appears, used or not — a shape with count 0 is the signal to
    // reach for, and it can only be that if it is actually on screen.
    const shapes: ShapeUse[] = PRODUCT_POST_SHAPES.map(
      (sh) => usedById.get(sh.id) ?? { shape: sh.id, label: sh.label, count: 0, daysSince: null, medianImpr: null },
    ).sort((a, b) => a.count - b.count || (b.medianImpr ?? 0) - (a.medianImpr ?? 0));

    const list = productsByTemplate.get(r.template) ?? [];
    list.push({
      product: r.product,
      label: productLabel(r.product),
      count: r.count,
      lastPosted: r.lastPosted,
      daysSince: r.daysSince,
      medianImpr: r.medianImpr,
      readiness: readinessOf(r.daysSince, def.staleDays),
      shapes,
      articles: [],
    });
    productsByTemplate.set(r.template, list);
  }

  // The single best proven post to re-run per pillar, from the last 3 months.
  // Highest impressions wins; ties broken by recency. Bounded to @eco's own
  // main posts (reposts/quotes of team-member articles already live here as
  // thought_leadership posts), so "post this specific article" is defensible.
  const suggestRows = await sql<SuggestedPost & { template: Template }>`
    WITH latest AS (
      SELECT p.id, p.url, p.text, p.created_at, p.template,
             p.media_type, p.media_urls, p.preview_image_url, p.link_image_url,
             p.quoted_image_url, p.link_title,
             s.impressions,
             EXTRACT(DAY FROM now() - p.created_at)::int AS "daysAgo",
             ROW_NUMBER() OVER (
               PARTITION BY p.template
               ORDER BY s.impressions DESC NULLS LAST, p.created_at DESC
             ) AS rn
      FROM posts p
      LEFT JOIN LATERAL (
        SELECT * FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
      ) s ON true
      WHERE p.template IS NOT NULL AND p.template <> 'other'
        AND p.is_reply = false
        AND (${includeAll} OR p.amplified = ${wantAmplified})
        AND p.created_at >= now() - (${SUGGEST_MAX_AGE_DAYS} || ' days')::interval
        AND (${filter.since}::timestamptz IS NULL OR p.created_at >= ${filter.since}::timestamptz)
    )
    SELECT id, url, text, created_at, template, media_type, media_urls,
           preview_image_url, link_image_url, quoted_image_url, link_title,
           impressions, "daysAgo"
    FROM latest WHERE rn = 1
  `;
  const suggestedByTemplate = new Map<Template, SuggestedPost>(
    suggestRows.map((r) => {
      const { template, ...post } = r;
      return [template, post];
    }),
  );

  // Clean performance baseline per pillar for scoring: ORGANIC posts only, with
  // each pillar's FIRST-EVER post excluded. Jay: "don't count the first post —
  // those are back-channeled with boosting, we were manufacturing success." So
  // the median a pillar is judged on never includes the amplified launch spike.
  const baselineRows = await sql<{ template: Template; baselineImpr: number | null }>`
    WITH latest AS (
      SELECT p.id, p.template, p.created_at, s.impressions,
             ROW_NUMBER() OVER (PARTITION BY p.template ORDER BY p.created_at ASC) AS seq
      FROM posts p
      LEFT JOIN LATERAL (
        SELECT * FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
      ) s ON true
      WHERE p.template IS NOT NULL AND p.template <> 'other'
        AND p.is_reply = false
        AND p.amplified = false
        AND (${filter.since}::timestamptz IS NULL OR p.created_at >= ${filter.since}::timestamptz)
    )
    SELECT template,
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY impressions)
            FILTER (WHERE seq > 1))::int AS "baselineImpr"
    FROM latest
    GROUP BY template
  `;
  const baselineByTemplate = new Map(baselineRows.map((r) => [r.template, r.baselineImpr]));

  // ------------------------------------------------------------------------
  // The two feedback signals the score rides on.
  //
  // Both replace the old rec-driven one (Migration 016). That signal only
  // existed for pillars where an operator had pressed "Mark as used" at least
  // twice, which in practice meant almost none of them.
  //
  //   articleCoverage — when each of our pieces was last put in front of the
  //     audience, by ANY pillar. Drives the pairing discount.
  //   trends          — each pillar's last 5 posts against the 5 before them.
  // ------------------------------------------------------------------------
  const [articleCoverage, trends, dmvLanes] = await Promise.all([
    getArticleCoverage(sql),
    getTemplateTrends(sql, filter),
    getDmvLanes(sql, filter),
  ]);
  // The coldest of the three data lanes, if any is past its own cadence. Read
  // before scoring because it OVERRIDES the pillar clock — see coldestLane().
  const dmvCold = coldestLane(dmvLanes);
  const trendByTemplate = new Map(trends.map((t) => [t.template, t]));

  // Which of our articles each pillar would DRAFT FROM. Keyed on articles.kind
  // rather than on the template of posts already filed there: kind is a property
  // of the piece, so a misclassified post can't move a piece onto the wrong
  // pillar's shelf. Read here (not from the article shelves further down) because
  // those load after the recommendations are assembled.
  const pairableRows = await sql<{ id: number; kind: string; chain: string | null; title: string }>`
    SELECT id::int AS id, kind, chain, title FROM articles
  `;
  const KIND_TO_TEMPLATE: Record<string, Template> = {
    chain_integration: "integration_announcement",
    product: "product_post",
    thought_leadership: "thought_leadership",
  };
  const pairablesByTemplate = new Map<Template, PairableTarget[]>();
  for (const a of pairableRows) {
    const tpl = KIND_TO_TEMPLATE[a.kind];
    if (!tpl) continue;
    const list = pairablesByTemplate.get(tpl) ?? [];
    // Chain pieces are named by their chain — that is how they appear on the
    // card and how the operator thinks about them ("Robinhood", not the title).
    list.push({ label: a.chain ? chainLabel(a.chain) : a.title, articleId: Number(a.id) });
    pairablesByTemplate.set(tpl, list);
  }

  // Rank baseline impressions across pillars → each pillar's performance
  // percentile (0..1). A pillar with no clean baseline gets null (neutral).
  const baselineVals = [...baselineByTemplate.values()].filter((v): v is number => v != null).sort((a, b) => a - b);
  const perfPctOf = (v: number | null): number | null => {
    if (v == null || baselineVals.length === 0) return null;
    const below = baselineVals.filter((x) => x <= v).length;
    return below / baselineVals.length;
  };

  const recommendations: Recommendation[] = overview
    .filter((t) => t.template !== "other")
    .map((t) => {
      // A LANE pillar is clocked on its coldest lane, not on its own last post.
      // Data Motion Visual posted yesterday and had gone 35 days without a
      // market-wide visual; scored on the aggregate it read "fresh", scored 0
      // and dropped off the board with the gap still hidden. The lane split only
      // pays for itself if the score can see it.
      const isLanePillar = TEMPLATE_BY_ID[t.template].draftMode === "dmv";
      const laneOverride = isLanePillar ? dmvCold : null;
      const clockDays = laneOverride ? laneOverride.lane.daysSince : t.daysSince;
      const clockStale = laneOverride ? laneOverride.staleDays : t.staleDays;

      const readiness = readinessOf(clockDays, clockStale);
      const baselineImpr = baselineByTemplate.get(t.template) ?? null;
      // "Discounted" = the displayed median is materially above the clean
      // baseline, i.e. amplified/launch posts were inflating it.
      const discounted = baselineImpr != null && t.medianImpr != null && t.medianImpr > baselineImpr * 1.15;
      const { score, reasons } = scoreParts({
        readiness,
        daysSince: clockDays,
        staleDays: clockStale,
        perfPct: perfPctOf(baselineImpr),
        baselineImpr,
        discounted,
      });
      if (laneOverride) {
        // Say which lane put it here, or "overdue by 21d" reads as a lie against
        // a pillar whose own last post was yesterday.
        reasons.unshift(
          `Clocked on its coldest lane — ${laneOverride.lane.label} (` +
            `${laneOverride.lane.daysSince == null ? "never posted" : `${laneOverride.lane.daysSince}d, ${laneOverride.staleDays}d cadence`})` +
            `, though the pillar itself posted ${agoText(t.daysSince)}`,
        );
      }
      if (isLanePillar && score > 0) reasons.push(...dmvLaneReasons(dmvLanes));

      // A chain pillar's staleness is about the FORMAT, not the subject. When
      // its chains have already been covered by other pillars, say so on the
      // card and name the ones that are actually cold — otherwise "27d stale"
      // reads as "nobody has heard about TRON in a month", which isn't true.
      const chainAngles = anglesByTemplate.get(t.template) ?? [];
      if (score > 0 && TEMPLATE_BY_ID[t.template].draftMode === "chains" && chainAngles.length > 0) {
        const warm = chainAngles.filter((c) => c.readiness === "fresh" && c.coveredElsewhere);
        if (warm.length > 0) {
          const named = warm
            .slice(0, 3)
            .map((c) => `${c.label} (${agoText(c.coverDaysSince)}, ${c.coverLabel})`)
            .join(", ");
          reasons.push(`Subject already warm — ${named}${warm.length > 3 ? `, +${warm.length - 3} more` : ""}`);
        }
        const cold = chainAngles.filter((c) => c.readiness !== "fresh");
        reasons.push(
          cold.length > 0
            ? `Cold chains: ${cold.slice(0, 4).map((c) => `${c.label} (${agoText(c.coverDaysSince)})`).join(", ")}`
            : `Every chain we've integrated has been covered recently — a NEW chain is the only fresh angle here`,
        );
      }

      // ------------------------------------------------------------------
      // Two adjustments, both of which used to be deliberately absent.
      //
      // PAIRING. The chain-coverage note above was a reason string and nothing
      // more, on the reasoning that the standalone announcement is still owed
      // and score_at_use had to stay comparable against logged uses. The first
      // half is still true and is why this is a discount rather than a mute.
      // The second half stopped applying when recommendation_uses was retired
      // (Migration 016), so the number is now free to tell the truth: a pillar
      // whose own source pieces have just been run elsewhere is not the most
      // urgent thing on the board. Keyed on the shared ARTICLE, not the shared
      // chain — see lib/articleCoverage.ts for why that distinction matters.
      //
      // TREND. Replaces the rec-driven adjustment, which needed a button
      // pressed and so measured logging diligence more than performance.
      // ------------------------------------------------------------------
      let adjScore = score;

      if (score > 0) {
        const pairing = pairingVerdict(t.template, pairablesByTemplate.get(t.template) ?? [], articleCoverage);
        if (pairing.multiplier !== 1) {
          adjScore = Math.max(1, Math.round(adjScore * pairing.multiplier));
          if (pairing.reason) reasons.push(pairing.reason);
        }
      }

      const tr = trendByTemplate.get(t.template);
      if (score > 0) {
        const verdict = trendVerdict(tr);
        if (verdict.multiplier !== 1) adjScore = Math.min(100, Math.max(1, Math.round(adjScore * verdict.multiplier)));
        if (verdict.reason) reasons.push(verdict.reason);
      }

      return {
        ...t,
        readiness,
        score: adjScore,
        scoreReasons: reasons,
        baselineImpr,
        discounted,
        trendFlag: tr?.flag ?? "insufficient",
        trendImprPct: tr?.imprPct ?? null,
        easyWin: EASY_WIN_TEMPLATES.has(t.template),
        chains: chainAngles,
        products: productsByTemplate.get(t.template) ?? [],
        suggested: suggestedByTemplate.get(t.template) ?? null,
      };
    })
    .sort((a, b) => b.score - a.score || (b.daysSince ?? -1) - (a.daysSince ?? -1));

  // Context-aware nudge: which chains are already live in the feed this week, so
  // the operator can ride adjacent topics ("you posted Tron yesterday — educate
  // something Tron-related") instead of starting cold.
  const recentChainRows = await sql<{ chain: string; count: number }>`
    WITH recent AS (
      SELECT unnest(chains) AS chain
      FROM posts
      WHERE is_reply = false
        AND created_at > now() - (${RECENT_CONTEXT_DAYS} || ' days')::interval
    )
    SELECT chain, COUNT(*)::int AS count
    FROM recent GROUP BY chain ORDER BY count DESC, chain LIMIT 6
  `;
  const recentChains: RecentChain[] = recentChainRows.map((r) => ({
    chain: r.chain,
    label: chainLabel(r.chain),
    count: r.count,
  }));

  // Past bangers old enough to recycle — top by impressions, older than the
  // re-amplify floor, so "re-post this one" is always defensible.
  const reAmplify = await sql<ReAmplifyPost>`
    SELECT p.id, p.url, p.created_at, p.text, p.template,
           p.media_type, p.media_urls, p.preview_image_url, p.link_image_url, p.quoted_image_url,
           p.chains, p.entities,
           EXTRACT(DAY FROM now() - p.created_at)::int AS "daysAgo",
           s.impressions
    FROM posts p
    LEFT JOIN LATERAL (
      SELECT * FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
    ) s ON true
    WHERE p.template IS NOT NULL AND p.template <> 'other'
      AND p.is_reply = false
      AND (${includeAll} OR p.amplified = ${wantAmplified})
      AND (${filter.since}::timestamptz IS NULL OR p.created_at >= ${filter.since}::timestamptz)
      AND p.created_at < now() - (${REAMPLIFY_MIN_AGE_DAYS} || ' days')::interval
      AND s.impressions IS NOT NULL
    ORDER BY s.impressions DESC NULLS LAST
    LIMIT 8
  `;
  for (const p of reAmplify) p.templateLabel = TEMPLATE_BY_ID[p.template].label;

  // Article shelves — ONE ROW PER ARTICLE, not per post. This is the change
  // Robert asked for: the shelf was reading each re-amplification as its own
  // article, so a piece we'd already run five times looked like five fresh
  // options. Now each row carries the aggregate across every post that used it,
  // plus the use count and how long it has rested (see lib/articles.ts).
  //
  // Each shelf is scoped to the KIND of article that pillar is actually for.
  // A post's template is a classification and can be wrong; the article's kind
  // is a property of the piece itself, so it is the better fence. The chain
  // shelf takes both kinds — an "Eco now supports X" post is carried by either.
  const shelfOpts = { includeAll, wantAmplified, since: filter.since };
  const [tlShelf, productShelf, chainShelf] = await Promise.all([
    getArticleShelf(["thought_leadership"], { ...shelfOpts, kinds: ["thought_leadership"] }),
    getArticleShelf(["product_post"], { ...shelfOpts, kinds: ["product"] }),
    getArticleShelf(["integration_announcement"], shelfOpts),
  ]);
  void chainShelf;
  const thoughtLeadership = tlShelf.filter((a) => a.articleId != null || a.useCount > 0);

  // Hang each product's articles off its angle row. The shelves are read after
  // the recommendations are assembled and the angle objects are shared by
  // reference, so this fills them in place.
  const productArticles = new Map<string, ArticleShelfRow[]>();
  for (const a of productShelf) {
    if (!a.product) continue;
    const list = productArticles.get(a.product) ?? [];
    list.push(a);
    productArticles.set(a.product, list);
  }
  // Articles with no product tag (or none we could attribute) are still
  // draftable — park them on every product-bearing pillar's first angle rather
  // than dropping them.
  const orphanArticles = productShelf.filter((a) => !a.product && a.articleId != null);
  for (const list of productsByTemplate.values()) {
    for (const pa of list) {
      pa.articles = (productArticles.get(pa.product) ?? []).slice().sort((x, y) => y.score - x.score);
    }
    if (list.length && orphanArticles.length) {
      list[0].articles = [...list[0].articles, ...orphanArticles];
    }
  }

  // Broad-educational "what worked", by approach (never reshare the same piece).
  const beTypeRows = await sql<BroadEdType>`
    SELECT p.media_type AS "mediaType", COUNT(*)::int AS count,
           ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY s.impressions))::int AS "medianImpr"
    FROM posts p
    LEFT JOIN LATERAL (
      SELECT impressions FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
    ) s ON true
    WHERE p.template = 'broad_educational' AND p.is_reply = false
      AND (${includeAll} OR p.amplified = ${wantAmplified})
      AND (${filter.since}::timestamptz IS NULL OR p.created_at >= ${filter.since}::timestamptz)
    GROUP BY p.media_type ORDER BY "medianImpr" DESC NULLS LAST
  `;
  const beEntityRows = await sql<{ entity: string; count: number; medianImpr: number | null }>`
    WITH exploded AS (
      SELECT unnest(p.entities) AS entity, s.impressions
      FROM posts p
      LEFT JOIN LATERAL (
        SELECT impressions FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
      ) s ON true
      WHERE p.template = 'broad_educational' AND p.is_reply = false
        AND (${includeAll} OR p.amplified = ${wantAmplified})
        AND (${filter.since}::timestamptz IS NULL OR p.created_at >= ${filter.since}::timestamptz)
    )
    SELECT entity, COUNT(*)::int AS count,
           ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY impressions))::int AS "medianImpr"
    FROM exploded GROUP BY entity ORDER BY "medianImpr" DESC NULLS LAST, count DESC LIMIT 6
  `;
  const beAngleRows = await sql<BroadEdAngle>`
    SELECT p.id, p.url, COALESCE(NULLIF(p.link_title, ''), p.text) AS title,
           s.impressions, p.created_at, p.media_type AS "mediaType", p.entities
    FROM posts p
    LEFT JOIN LATERAL (
      SELECT impressions FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
    ) s ON true
    WHERE p.template = 'broad_educational' AND p.is_reply = false
      AND (${includeAll} OR p.amplified = ${wantAmplified})
      AND (${filter.since}::timestamptz IS NULL OR p.created_at >= ${filter.since}::timestamptz)
    ORDER BY s.impressions DESC NULLS LAST
    LIMIT 4
  `;
  const broadEducational: BroadEdBreakdown = {
    byType: beTypeRows,
    topEntities: beEntityRows.map((e) => ({ ...e, label: entityLabel(e.entity) })),
    topAngles: beAngleRows,
  };

  // The two registry-first shelves. Read unconditionally rather than only when
  // their pillar is on screen: both are small, and the Prioritize page renders
  // every pillar's card at once.
  const [docPages, homepagePenalty, videos, curriculum, angleBank] = await Promise.all([
    getDocShelf(),
    getHomepagePenalty(),
    getVideoShelf(),
    getCurriculumShelf(),
    getAngleBank(sql),
  ]);

  return {
    recommendations,
    reAmplify,
    recentChains,
    thoughtLeadership,
    broadEducational,
    docPages,
    homepagePenalty,
    videos,
    curriculum,
    dmvLanes,
    angleBank,
  };
}

export async function getTemplateDetail(template: Template, filter: StatFilter): Promise<TemplateDetail> {
  const overview = await getOverview(filter);
  const stat = overview.find((s) => s.template === template)!;
  const { includeAll, wantAmplified } = ampFlags(filter.amplified);

  // Every post in this template/window (default order: most impressions first).
  // The client table lets the operator re-sort by date or engagement without a
  // round-trip, so we return the full set rather than a top-N.
  const posts = await sql<TopPost>`
    SELECT p.id, p.url, p.created_at, p.text, p.amplified, p.template,
           p.media_type, p.media_urls, p.preview_image_url, p.link_image_url, p.quoted_image_url,
           s.impressions, s.likes, s.replies, s.bookmarks
    FROM posts p
    LEFT JOIN LATERAL (
      SELECT * FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
    ) s ON true
    WHERE p.template = ${template}::content_template
      AND p.is_reply = false
      AND (${includeAll} OR p.amplified = ${wantAmplified})
      AND (${filter.since}::timestamptz IS NULL OR p.created_at >= ${filter.since}::timestamptz)
    ORDER BY s.impressions DESC NULLS LAST
  `;

  const weekly = await sql<WeeklyPoint>`
    SELECT to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS week, COUNT(*)::int AS count
    FROM posts
    WHERE template = ${template}::content_template
      AND is_reply = false
      AND (${includeAll} OR amplified = ${wantAmplified})
      AND (${filter.since}::timestamptz IS NULL OR created_at >= ${filter.since}::timestamptz)
    GROUP BY 1 ORDER BY 1
  `;

  return { stat, posts, weekly };
}
