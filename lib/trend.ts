import { TEMPLATE_BY_ID, TEMPLATES, type Template } from "./taxonomy.ts";

// Per-pillar engagement TREND. Jay's ask, close to verbatim:
//
//   "with your tracker, it should also be like, hey, the last 10 posts have
//    averaged 15 likes, and the most recent 11th post has dropped an average to
//    5 likes… and then it should also be able to tell you, yo, I think there's
//    something wrong with the way you're pushing these templates."
//
// And immediately after, the limit on it:
//
//   "I don't think the app is good enough to be able to tell you if there's
//    content fatigue specifically, but at least you know what to triage."
//
// So this module measures and does not diagnose. It says "Dev Doc Post is down
// 61% against its own prior five" and stops there. Naming the cause — fatigue,
// a bad angle, a dead hour, the timeline being busy — is the operator's job,
// and the sentence that would guess at it is the sentence that gets the tool
// distrusted the first time it guesses wrong.
//
// This replaces recommendation_uses (Migration 016) as the pillar-level
// performance signal. That one needed a button pressed, which meant it measured
// how diligently the operator logged work rather than how the work did; this
// one reads every post and needs nothing.

/** How many posts make up each half of the comparison. */
const WINDOW = 5;

/** Below this, a pillar has not published enough for a comparison to mean anything. */
const MIN_FOR_TREND = WINDOW + 2;

/** Percentage move that counts as a real change rather than noise. */
const FLAT_BAND = 15;

export type TrendFlag = "improving" | "flat" | "declining" | "insufficient";

export interface TrendPost {
  id: string;
  url: string;
  createdAt: string;
  text: string;
  impressions: number | null;
  engagements: number | null;
  amplified: boolean;
}

export interface TemplateTrend {
  template: Template;
  label: string;
  /** Posts counted, after the amplified/date filter. */
  n: number;
  /** Median impressions of the most recent WINDOW posts. */
  recentImpr: number | null;
  /** Median impressions of the WINDOW before those. */
  priorImpr: number | null;
  /** Signed % change in median impressions, recent vs prior. */
  imprPct: number | null;
  /** Same pair for engagements (likes+replies+reposts+quotes+bookmarks). */
  recentEng: number | null;
  priorEng: number | null;
  engPct: number | null;
  flag: TrendFlag;
  /** The most recent WINDOW*2 posts, newest first — the receipts behind the number. */
  posts: TrendPost[];
}

type SqlTag = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...params: unknown[]
) => Promise<T[]>;

function median(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

// Median, not mean, and this is the one place it matters. One launch post at
// 300k impressions drags a five-post mean above anything the pillar will do
// again, so a mean-based trend reads "declining" for a fortnight afterwards
// purely because the outlier aged out of the window. The median moves when the
// typical post moves, which is the question being asked.
function pctChange(recent: number | null, prior: number | null): number | null {
  if (recent == null || prior == null || prior === 0) return null;
  return Math.round(((recent - prior) / prior) * 1000) / 10;
}

function flagOf(imprPct: number | null, engPct: number | null, n: number): TrendFlag {
  if (n < MIN_FOR_TREND) return "insufficient";
  // Impressions lead, engagement confirms. When they disagree the pillar is
  // doing something interesting (reach down but resonance up, or the reverse)
  // and "flat" is the honest label for "this needs a human to look".
  const primary = imprPct ?? engPct;
  if (primary == null) return "insufficient";
  const secondary = imprPct != null ? engPct : null;
  if (secondary != null && Math.sign(secondary) !== Math.sign(primary) && Math.abs(secondary) > FLAT_BAND) {
    return "flat";
  }
  if (primary > FLAT_BAND) return "improving";
  if (primary < -FLAT_BAND) return "declining";
  return "flat";
}

export interface TrendFilterish {
  amplified: "all" | "organic" | "amplified";
  since: string | null;
}

/**
 * One trend row per template, in taxonomy order.
 *
 * Reads each post's LATEST metric snapshot, same as every other stat, so a post
 * still accumulating impressions is compared on today's number rather than the
 * one it had at ingest.
 */
export async function getTemplateTrends(sql: SqlTag, filter: TrendFilterish): Promise<TemplateTrend[]> {
  const includeAll = filter.amplified === "all";
  const wantAmplified = filter.amplified === "amplified";

  const rows = await sql<{
    template: Template;
    id: string;
    url: string;
    createdAt: string;
    text: string;
    impressions: number | null;
    engagements: number | null;
    amplified: boolean;
    rn: number;
  }>`
    WITH latest AS (
      SELECT p.id, p.url, p.template, p.created_at, p.text, p.amplified,
             s.impressions,
             (COALESCE(s.likes,0) + COALESCE(s.replies,0) + COALESCE(s.retweets,0)
              + COALESCE(s.quotes,0) + COALESCE(s.bookmarks,0)) AS engagements
      FROM posts p
      LEFT JOIN LATERAL (
        SELECT * FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
      ) s ON true
      WHERE p.template IS NOT NULL
        AND p.is_reply = false
        AND (${includeAll} OR p.amplified = ${wantAmplified})
        AND (${filter.since}::timestamptz IS NULL OR p.created_at >= ${filter.since}::timestamptz)
    )
    SELECT template, id, url, created_at AS "createdAt", text, impressions, engagements::int, amplified,
           ROW_NUMBER() OVER (PARTITION BY template ORDER BY created_at DESC)::int AS rn
    FROM latest
  `;

  const byTemplate = new Map<Template, typeof rows>();
  for (const r of rows) {
    const list = byTemplate.get(r.template) ?? ([] as unknown as typeof rows);
    list.push(r);
    byTemplate.set(r.template, list);
  }

  return TEMPLATES.map((t) => {
    const def = TEMPLATE_BY_ID[t];
    const all = (byTemplate.get(t) ?? []).slice().sort((a, b) => a.rn - b.rn); // newest first
    const recent = all.slice(0, WINDOW);
    const prior = all.slice(WINDOW, WINDOW * 2);

    const recentImpr = median(recent.map((r) => r.impressions ?? NaN));
    const priorImpr = median(prior.map((r) => r.impressions ?? NaN));
    const recentEng = median(recent.map((r) => r.engagements ?? NaN));
    const priorEng = median(prior.map((r) => r.engagements ?? NaN));
    const imprPct = pctChange(recentImpr, priorImpr);
    const engPct = pctChange(recentEng, priorEng);

    return {
      template: t,
      label: def.label,
      n: all.length,
      recentImpr,
      priorImpr,
      imprPct,
      recentEng,
      priorEng,
      engPct,
      flag: flagOf(imprPct, engPct, all.length),
      posts: all.slice(0, WINDOW * 2).map((r) => ({
        id: r.id,
        url: r.url,
        createdAt: r.createdAt,
        text: r.text,
        impressions: r.impressions,
        engagements: r.engagements,
        amplified: r.amplified,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// The scoring hook
// ---------------------------------------------------------------------------

export interface TrendVerdict {
  multiplier: number;
  reason: string | null;
}

/**
 * How a pillar's trend nudges its priority.
 *
 * Small on purpose, and in the direction that is easy to defend. A declining
 * pillar is NOT pushed down the board: "this format is cooling" is an argument
 * for looking at it, and burying it would hide exactly what Jay wanted
 * surfaced. It gets flagged instead, and the flag rides the reason list.
 *
 * A pillar on the way UP earns a real nudge, because that is the case where
 * doing more of the same thing is the obviously correct move.
 */
export function trendVerdict(t: TemplateTrend | undefined): TrendVerdict {
  if (!t || t.flag === "insufficient" || t.imprPct == null) return { multiplier: 1, reason: null };
  const pct = t.imprPct;
  const dir = pct > 0 ? "up" : "down";
  const body = `Trend ${dir} ${Math.abs(pct).toFixed(0)}% — last ${WINDOW} median ${fmt(t.recentImpr)} vs ${fmt(t.priorImpr)} prior`;
  if (t.flag === "improving") return { multiplier: 1.1, reason: `${body}. Riding it.` };
  if (t.flag === "declining") {
    return { multiplier: 1, reason: `${body}. Worth reviewing the angle before the next one.` };
  }
  return { multiplier: 1, reason: null };
}

function fmt(n: number | null): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1000)
    return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  return String(Math.round(n));
}

export { WINDOW as TREND_WINDOW };
