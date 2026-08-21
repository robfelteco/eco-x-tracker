import { sql } from "./db";
import { TEMPLATE_BY_ID, type Template } from "./taxonomy";
import { chainLabel } from "./dimensions";

// The recursion loop's data layer. See db/schema.sql Migration 005 for the
// full rationale. Three moves:
//   createUse   — operator acted on a recommendation ("Mark as used").
//   attributeUses — at sync, tie open uses to the @eco posts that fulfilled them.
//   getHistory / getRecDrivenPerf — read the loop back out (History tab + a
//     scoring signal so pillars whose rec-driven posts flop get nudged down).

export interface CreateUseInput {
  template: Template;
  chain?: string | null;
  angle?: string | null;
  scoreAtUse?: number | null;
  suggestedPostId?: string | null;
  usedBy?: string | null;
}

export async function createUse(input: CreateUseInput): Promise<number> {
  const rows = await sql<{ id: number }>`
    INSERT INTO recommendation_uses (template, chain, angle, score_at_use, suggested_post_id, used_by)
    VALUES (
      ${input.template}::content_template,
      ${input.chain ?? null},
      ${input.angle ?? null},
      ${input.scoreAtUse ?? null},
      ${input.suggestedPostId ?? null},
      ${input.usedBy || "public"}
    )
    RETURNING id
  `;
  return rows[0].id;
}

export async function dismissUse(id: number): Promise<boolean> {
  const rows = await sql<{ id: number }>`
    UPDATE recommendation_uses SET status = 'dismissed'
    WHERE id = ${id} AND status = 'open'
    RETURNING id
  `;
  return rows.length > 0;
}

// How long after acting on a recommendation we'll still credit a matching post
// to it. Beyond this the operator almost certainly posted something unrelated.
const ATTRIB_WINDOW_DAYS = 10;

// Tie open uses to the @eco posts that fulfilled them. Called at the end of a
// sync, AFTER new posts are ingested + classified. For each open use (oldest
// first), claim the earliest not-yet-attributed post of the same pillar — and
// same chain, if a chain angle was chosen — published after the use and inside
// the window. Deliberately conservative: no open use waiting → the post stays
// organic and the engine takes no credit. Returns the count newly matched.
export async function attributeUses(): Promise<number> {
  const open = await sql<{ id: number; template: Template; chain: string | null; used_at: string }>`
    SELECT id, template, chain, used_at
    FROM recommendation_uses
    WHERE status = 'open'
    ORDER BY used_at ASC
  `;

  let matched = 0;
  for (const u of open) {
    const rows = await sql<{ id: number }>`
      WITH candidate AS (
        SELECT p.id
        FROM posts p
        WHERE p.template = ${u.template}::content_template
          AND p.is_reply = false
          AND p.created_at >= ${u.used_at}::timestamptz
          AND p.created_at <= ${u.used_at}::timestamptz + (${ATTRIB_WINDOW_DAYS} || ' days')::interval
          AND (${u.chain}::text IS NULL OR ${u.chain} = ANY(p.chains))
          -- not already claimed by another use
          AND NOT EXISTS (
            SELECT 1 FROM recommendation_uses r
            WHERE r.matched_post_id = p.id
          )
        ORDER BY p.created_at ASC
        LIMIT 1
      )
      UPDATE recommendation_uses
      SET status = 'matched', matched_post_id = (SELECT id FROM candidate), matched_at = now()
      WHERE id = ${u.id} AND EXISTS (SELECT 1 FROM candidate)
      RETURNING id
    `;
    if (rows.length) matched++;
  }
  return matched;
}

export interface HistoryRow {
  id: number;
  template: Template;
  templateLabel: string;
  chain: string | null;
  chainLabel: string | null;
  angle: string | null;
  scoreAtUse: number | null;
  status: string;
  usedAt: string;
  matchedAt: string | null;
  // Resulting post (once matched).
  postId: string | null;
  postUrl: string | null;
  postText: string | null;
  postCreatedAt: string | null;
  impressions: number | null;
  // The pillar's median impressions (organic, launch post excluded) at read
  // time — so History can say whether the rec-driven post beat the baseline.
  pillarMedian: number | null;
}

export async function getHistory(limit = 100): Promise<HistoryRow[]> {
  const rows = await sql<Omit<HistoryRow, "templateLabel" | "chainLabel">>`
    WITH baseline AS (
      SELECT template, ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY impr))::int AS median
      FROM (
        SELECT p.template,
               s.impressions AS impr,
               ROW_NUMBER() OVER (PARTITION BY p.template ORDER BY p.created_at ASC) AS seq
        FROM posts p
        LEFT JOIN LATERAL (
          SELECT impressions FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
        ) s ON true
        WHERE p.is_reply = false AND p.amplified = false AND p.template IS NOT NULL
      ) q
      WHERE seq > 1
      GROUP BY template
    )
    SELECT
      ru.id, ru.template, ru.chain, ru.angle,
      ru.score_at_use AS "scoreAtUse", ru.status,
      ru.used_at AS "usedAt", ru.matched_at AS "matchedAt",
      p.id AS "postId", p.url AS "postUrl", p.text AS "postText", p.created_at AS "postCreatedAt",
      s.impressions AS "impressions",
      b.median AS "pillarMedian"
    FROM recommendation_uses ru
    LEFT JOIN posts p ON p.id = ru.matched_post_id
    LEFT JOIN LATERAL (
      SELECT impressions FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
    ) s ON true
    LEFT JOIN baseline b ON b.template = ru.template
    WHERE ru.status <> 'dismissed'
    ORDER BY ru.used_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    ...r,
    templateLabel: TEMPLATE_BY_ID[r.template]?.label ?? r.template,
    chainLabel: r.chain ? chainLabel(r.chain) : null,
  }));
}

export interface RecDrivenPerf {
  template: Template;
  matchedCount: number;
  medianImpr: number | null; // median impressions of this pillar's rec-driven posts
  vsBaseline: number | null; // ratio of rec-driven median to the pillar baseline (1 = on par)
}

// Per-pillar performance of posts that CAME FROM a recommendation, vs the
// pillar's clean baseline. Feeds the scoring nudge: a pillar whose rec-driven
// posts consistently underperform gets recommended a little less confidently.
export async function getRecDrivenPerf(): Promise<Map<Template, RecDrivenPerf>> {
  const rows = await sql<{
    template: Template;
    matchedCount: number;
    medianImpr: number | null;
    baseline: number | null;
  }>`
    WITH matched AS (
      SELECT ru.template, s.impressions AS impr
      FROM recommendation_uses ru
      JOIN posts p ON p.id = ru.matched_post_id
      LEFT JOIN LATERAL (
        SELECT impressions FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
      ) s ON true
      WHERE ru.status = 'matched'
    ),
    baseline AS (
      SELECT template, ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY impr))::int AS median
      FROM (
        SELECT p.template, s.impressions AS impr,
               ROW_NUMBER() OVER (PARTITION BY p.template ORDER BY p.created_at ASC) AS seq
        FROM posts p
        LEFT JOIN LATERAL (
          SELECT impressions FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
        ) s ON true
        WHERE p.is_reply = false AND p.amplified = false AND p.template IS NOT NULL
      ) q WHERE seq > 1 GROUP BY template
    )
    SELECT m.template,
      COUNT(*)::int AS "matchedCount",
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY m.impr))::int AS "medianImpr",
      b.median AS baseline
    FROM matched m
    LEFT JOIN baseline b ON b.template = m.template
    GROUP BY m.template, b.median
  `;
  const out = new Map<Template, RecDrivenPerf>();
  for (const r of rows) {
    out.set(r.template, {
      template: r.template,
      matchedCount: r.matchedCount,
      medianImpr: r.medianImpr,
      vsBaseline: r.medianImpr != null && r.baseline ? r.medianImpr / r.baseline : null,
    });
  }
  return out;
}
