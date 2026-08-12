import { sql } from "./db";
import { TEMPLATE_BY_ID, type Template } from "./taxonomy";

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

export async function getTemplateDetail(template: Template, filter: StatFilter): Promise<TemplateDetail> {
  const overview = await getOverview(filter);
  const stat = overview.find((s) => s.template === template)!;
  const { includeAll, wantAmplified } = ampFlags(filter.amplified);

  const topPosts = await sql<TopPost>`
    SELECT p.id, p.url, p.created_at, p.text, p.amplified,
           s.impressions, s.likes, s.replies, s.bookmarks
    FROM posts p
    LEFT JOIN LATERAL (
      SELECT * FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
    ) s ON true
    WHERE p.template = ${template}::content_template
      AND (${includeAll} OR p.amplified = ${wantAmplified})
      AND (${filter.since}::timestamptz IS NULL OR p.created_at >= ${filter.since}::timestamptz)
    ORDER BY s.impressions DESC NULLS LAST
    LIMIT 10
  `;

  const weekly = await sql<WeeklyPoint>`
    SELECT to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS week, COUNT(*)::int AS count
    FROM posts
    WHERE template = ${template}::content_template
      AND (${includeAll} OR amplified = ${wantAmplified})
      AND (${filter.since}::timestamptz IS NULL OR created_at >= ${filter.since}::timestamptz)
    GROUP BY 1 ORDER BY 1
  `;

  return { stat, topPosts, weekly };
}
