import { sql } from "./db";
import { REVIEW_THRESHOLD, type Template } from "./taxonomy";

export interface PostRow {
  id: string;
  url: string;
  created_at: string;
  text: string;
  media_type: string;
  is_reply: boolean;
  is_self_reply: boolean;
  is_quote: boolean;
  amplified: boolean;
  template: Template | null;
  confidence: number | null;
  class_source: string | null;
  impressions: number | null;
  likes: number | null;
  replies: number | null;
  retweets: number | null;
  bookmarks: number | null;
  snapshot_count: number;
}

// Posts joined to their LATEST metric snapshot, plus how many snapshots exist
// (so we can tell at a glance whether the growth curve is filling).
export async function getPostsWithLatest(limit = 200): Promise<PostRow[]> {
  const rows = await sql<PostRow>`
    SELECT
      p.id, p.url, p.created_at, p.text, p.media_type,
      p.is_reply, p.is_self_reply, p.is_quote, p.amplified,
      p.template, p.confidence, p.class_source,
      s.impressions, s.likes, s.replies, s.retweets, s.bookmarks,
      COALESCE(sc.n, 0) AS snapshot_count
    FROM posts p
    LEFT JOIN LATERAL (
      SELECT impressions, likes, replies, retweets, bookmarks
      FROM metric_snapshots ms
      WHERE ms.post_id = p.id
      ORDER BY ms.fetched_at DESC
      LIMIT 1
    ) s ON true
    LEFT JOIN (
      SELECT post_id, COUNT(*)::int AS n FROM metric_snapshots GROUP BY post_id
    ) sc ON sc.post_id = p.id
    ORDER BY p.created_at DESC
    LIMIT ${limit}
  `;
  return rows;
}

export interface SyncRunRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  trigger: string;
  ok: boolean | null;
  posts_added: number;
  posts_updated: number;
  snapshots: number;
  x_reads: number;
  est_cost_usd: string;
  summary: string | null;
}

export async function getLastSyncRun(): Promise<SyncRunRow | null> {
  const rows = await sql<SyncRunRow>`SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1`;
  return rows[0] ?? null;
}

export async function getPostCount(): Promise<number> {
  const rows = await sql<{ n: number }>`SELECT COUNT(*)::int AS n FROM posts`;
  return rows[0]?.n ?? 0;
}

export interface ReviewRow {
  id: string;
  url: string;
  created_at: string;
  text: string;
  media_type: string;
  preview_image_url: string | null;
  media_urls: string[];
  template: Template | null;
  confidence: number | null;
  reasoning: string | null;
  class_source: string | null;
}

// The review queue: classified with low confidence, bucketed as 'other', or not
// yet classified — and never already human-verified. Highest-uncertainty first.
export async function getReviewQueue(limit = 100): Promise<ReviewRow[]> {
  const rows = await sql<ReviewRow>`
    SELECT id, url, created_at, text, media_type, preview_image_url, media_urls,
           template, confidence, reasoning, class_source
    FROM posts
    WHERE class_source IS DISTINCT FROM 'human'
      AND (template IS NULL OR template = 'other' OR confidence < ${REVIEW_THRESHOLD})
    ORDER BY (template IS NULL) DESC, confidence ASC NULLS FIRST, created_at DESC
    LIMIT ${limit}`;
  return rows;
}

export async function getReviewCount(): Promise<number> {
  const rows = await sql<{ n: number }>`
    SELECT COUNT(*)::int AS n FROM posts
    WHERE class_source IS DISTINCT FROM 'human'
      AND (template IS NULL OR template = 'other' OR confidence < ${REVIEW_THRESHOLD})`;
  return rows[0]?.n ?? 0;
}
