import { sql } from "./db.ts";
import { TEMPLATE_BY_ID, type Template } from "./taxonomy.ts";
import { chainLabel, entityLabel } from "./dimensions.ts";
import { productLabel, SHAPE_BY_ID, PRODUCT_POST_SHAPES } from "./products.ts";
import { getArticleShelf, type ArticleShelfRow } from "./articles.ts";
import { getRecDrivenPerf } from "./recUses.ts";

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

export interface ChainAngle {
  chain: string;
  label: string;
  count: number;
  lastPosted: string | null;
  daysSince: number | null;
  medianImpr: number | null;
  avgImpr: number | null;
  readiness: Readiness;
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
  recDrivenCount: number; // # of posts this pillar has produced FROM a recommendation
  recDrivenVsBaseline: number | null; // rec-driven median ÷ baseline (1 = on par); null if none
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
}

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

  const anglesByTemplate = new Map<Template, ChainAngle[]>();
  for (const a of angleRows) {
    const def = TEMPLATE_BY_ID[a.template];
    const list = anglesByTemplate.get(a.template) ?? [];
    list.push({
      chain: a.chain,
      label: chainLabel(a.chain),
      count: a.count,
      lastPosted: a.lastPosted,
      daysSince: a.daysSince,
      medianImpr: a.medianImpr,
      avgImpr: a.avgImpr,
      readiness: readinessOf(a.daysSince, def.staleDays),
    });
    anglesByTemplate.set(a.template, list);
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

  // Feedback signal: how posts this pillar produced FROM a recommendation have
  // actually performed vs its baseline. This is what makes the engine recursive.
  const recDriven = await getRecDrivenPerf();

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
      const readiness = readinessOf(t.daysSince, t.staleDays);
      const baselineImpr = baselineByTemplate.get(t.template) ?? null;
      // "Discounted" = the displayed median is materially above the clean
      // baseline, i.e. amplified/launch posts were inflating it.
      const discounted = baselineImpr != null && t.medianImpr != null && t.medianImpr > baselineImpr * 1.15;
      const { score, reasons } = scoreParts({
        readiness,
        daysSince: t.daysSince,
        staleDays: t.staleDays,
        perfPct: perfPctOf(baselineImpr),
        baselineImpr,
        discounted,
      });

      // Recursive adjustment: once a pillar has ≥2 rec-driven posts, nudge its
      // score by how those posts did vs baseline. Underperformers cool off;
      // over-performers get a small boost. Only applied to a live (non-zero)
      // score so resting pillars stay resting.
      const rd = recDriven.get(t.template);
      let adjScore = score;
      if (score > 0 && rd && rd.matchedCount >= 2 && rd.vsBaseline != null) {
        if (rd.vsBaseline < 0.8) {
          adjScore = Math.max(1, Math.round(score * 0.85));
          reasons.push(`Cooled — recent posts you ran from this averaged below its baseline`);
        } else if (rd.vsBaseline > 1.2) {
          adjScore = Math.min(100, Math.round(score * 1.1));
          reasons.push(`Boosted — posts you ran from this beat its baseline`);
        }
      }

      return {
        ...t,
        readiness,
        score: adjScore,
        scoreReasons: reasons,
        baselineImpr,
        discounted,
        recDrivenCount: rd?.matchedCount ?? 0,
        recDrivenVsBaseline: rd?.vsBaseline ?? null,
        easyWin: EASY_WIN_TEMPLATES.has(t.template),
        chains: anglesByTemplate.get(t.template) ?? [],
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
  const shelfOpts = { includeAll, wantAmplified, since: filter.since };
  const [tlShelf, productShelf, chainShelf] = await Promise.all([
    getArticleShelf(["thought_leadership"], shelfOpts),
    getArticleShelf(["product_post"], shelfOpts),
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

  return { recommendations, reAmplify, recentChains, thoughtLeadership, broadEducational };
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
