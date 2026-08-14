import { sql } from "./db";
import { TEMPLATE_BY_ID, type Template } from "./taxonomy";
import { chainLabel } from "./dimensions";

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
      SELECT p.id, p.template, p.created_at,
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
  topPosts: TopPost[];
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

export interface Recommendation extends TemplateStat {
  readiness: Readiness;
  score: number;
  chains: ChainAngle[]; // best-performing chain angles for this pillar, if any
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

export interface Insights {
  recommendations: Recommendation[];
  reAmplify: ReAmplifyPost[];
}

// How old a post must be before re-amplifying it makes sense.
const REAMPLIFY_MIN_AGE_DAYS = 45;

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

  const recommendations: Recommendation[] = overview
    .filter((t) => t.template !== "other")
    .map((t) => {
      const perf = t.medianImpr ?? t.avgImpr ?? 0;
      return {
        ...t,
        readiness: readinessOf(t.daysSince, t.staleDays),
        score: Math.round(perf * recencyWeight(t.daysSince, t.staleDays)),
        chains: anglesByTemplate.get(t.template) ?? [],
      };
    })
    .sort((a, b) => b.score - a.score || (b.daysSince ?? -1) - (a.daysSince ?? -1));

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

  return { recommendations, reAmplify };
}

export async function getTemplateDetail(template: Template, filter: StatFilter): Promise<TemplateDetail> {
  const overview = await getOverview(filter);
  const stat = overview.find((s) => s.template === template)!;
  const { includeAll, wantAmplified } = ampFlags(filter.amplified);

  const topPosts = await sql<TopPost>`
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
    LIMIT 10
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

  return { stat, topPosts, weekly };
}
