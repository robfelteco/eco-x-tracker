import { sql } from "./db.ts";
import { productLabel } from "./products.ts";


export {
  ecoBlogSlug,
  xArticleId,
  ecoStatusId,
  anyStatusUrl,
  normTitle,
  titleSimilarity,
  TITLE_MATCH_THRESHOLD,
} from "./articleKeys.ts";

// The ARTICLE layer.
//
// Both Thought Leadership and Product Posts sit on a small shelf of underlying
// articles that get re-amplified for weeks. The tracker used to read each
// amplifier as its own article, which made the shelf noisy and hid the one
// number that matters when you're deciding what to post: how many times have we
// already run this piece, and how did those runs do?
//
// This module owns (a) the deterministic URL helpers that identify an article,
// (b) the attribution ladder that ties a post to one, and (c) the shelf reads.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArticleRow {
  id: number;
  slug: string;
  title: string;
  dek: string | null;
  author: string | null;
  publishedOn: string | null;
  canonicalUrl: string | null;
  xArticleUrl: string | null;
  anchorPostId: string | null;
  kind: "product" | "thought_leadership";
  product: string | null;
  body: string | null;
}

// One row per ARTICLE on the shelf — the aggregate across every @eco post that
// used it. This is what replaced the old one-row-per-post TL list.
export interface ArticleShelfRow {
  articleId: number | null; // null = the residual "not matched to an article" group
  slug: string | null;
  title: string;
  dek: string | null;
  author: string | null;
  publishedOn: string | null;
  canonicalUrl: string | null;
  xArticleUrl: string | null;
  kind: string | null;
  product: string | null;
  productLabel: string | null;
  useCount: number; // how many @eco posts have used this article
  firstUsed: string | null;
  lastUsed: string | null;
  daysSinceLastUse: number | null;
  totalImpr: number | null;
  medianImpr: number | null;
  bestImpr: number | null;
  avgEngRate: number | null;
  score: number; // 0..100 "worth re-amplifying now"
  posts: ArticleUse[];
}

export interface ArticleUse {
  id: string;
  url: string;
  createdAt: string;
  daysAgo: number;
  text: string;
  mediaType: string;
  impressions: number | null;
  isAnchor: boolean; // the bare-link post that carried the article itself
}

// ---------------------------------------------------------------------------
// The shelf read
// ---------------------------------------------------------------------------

interface ShelfSqlRow {
  articleId: number | null;
  slug: string | null;
  title: string | null;
  dek: string | null;
  author: string | null;
  publishedOn: string | null;
  canonicalUrl: string | null;
  xArticleUrl: string | null;
  kind: string | null;
  product: string | null;
  anchorPostId: string | null;
  useCount: number;
  firstUsed: string | null;
  lastUsed: string | null;
  daysSinceLastUse: number | null;
  totalImpr: number | null;
  medianImpr: number | null;
  bestImpr: number | null;
  avgEngRate: number | null;
}

// Group every post in `templates` by its article. Posts with no article land in
// one residual row (articleId null) so nothing silently disappears from the
// shelf — an unattributed piece is still a piece you could re-run.
export async function getArticleShelf(
  templates: string[],
  opts: { includeAll: boolean; wantAmplified: boolean; since: string | null },
): Promise<ArticleShelfRow[]> {
  const rows = await sql<ShelfSqlRow>`
    WITH latest AS (
      SELECT p.id, p.url, p.text, p.created_at, p.media_type, p.article_id, p.link_title,
             s.impressions,
             CASE WHEN s.impressions > 0
                  THEN (s.likes + s.replies + s.retweets + s.quotes + s.bookmarks)::float / s.impressions
             END AS eng_rate
      FROM posts p
      LEFT JOIN LATERAL (
        SELECT * FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
      ) s ON true
      WHERE p.template::text = ANY(${templates})
        AND p.is_reply = false
        AND (${opts.includeAll} OR p.amplified = ${opts.wantAmplified})
        AND (${opts.since}::timestamptz IS NULL OR p.created_at >= ${opts.since}::timestamptz)
    )
    SELECT
      a.id                                   AS "articleId",
      a.slug, a.title, a.dek, a.author,
      to_char(a.published_on, 'YYYY-MM-DD')  AS "publishedOn",
      a.canonical_url                        AS "canonicalUrl",
      a.x_article_url                        AS "xArticleUrl",
      a.kind, a.product,
      a.anchor_post_id                       AS "anchorPostId",
      COUNT(*)::int                          AS "useCount",
      MIN(l.created_at)                      AS "firstUsed",
      MAX(l.created_at)                      AS "lastUsed",
      EXTRACT(DAY FROM now() - MAX(l.created_at))::int AS "daysSinceLastUse",
      SUM(l.impressions)::int                AS "totalImpr",
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY l.impressions))::int AS "medianImpr",
      MAX(l.impressions)::int                AS "bestImpr",
      AVG(l.eng_rate)                        AS "avgEngRate"
    FROM latest l
    LEFT JOIN articles a ON a.id = l.article_id
    GROUP BY a.id, a.slug, a.title, a.dek, a.author, a.published_on, a.canonical_url,
             a.x_article_url, a.kind, a.product, a.anchor_post_id
    ORDER BY "medianImpr" DESC NULLS LAST
  `;

  const useRows = await sql<ArticleUse & { articleId: number | null }>`
    SELECT p.article_id AS "articleId", p.id, p.url, p.created_at AS "createdAt",
           EXTRACT(DAY FROM now() - p.created_at)::int AS "daysAgo",
           p.text, p.media_type AS "mediaType", s.impressions,
           (a.anchor_post_id = p.id) AS "isAnchor"
    FROM posts p
    LEFT JOIN articles a ON a.id = p.article_id
    LEFT JOIN LATERAL (
      SELECT impressions FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
    ) s ON true
    WHERE p.template::text = ANY(${templates})
      AND p.is_reply = false
      AND (${opts.includeAll} OR p.amplified = ${opts.wantAmplified})
      AND (${opts.since}::timestamptz IS NULL OR p.created_at >= ${opts.since}::timestamptz)
    ORDER BY s.impressions DESC NULLS LAST
  `;
  // bigint columns arrive as strings from the driver; normalise so the join key
  // below and the ids the UI round-trips are consistently numbers.
  const usesByArticle = new Map<number | null, ArticleUse[]>();
  for (const u of useRows) {
    const key = u.articleId == null ? null : Number(u.articleId);
    const list = usesByArticle.get(key) ?? [];
    const { articleId: _drop, ...use } = u;
    list.push({ ...use, isAnchor: !!use.isAnchor });
    usesByArticle.set(key, list);
  }

  const medians = rows.map((r) => r.medianImpr ?? 0);
  const maxMedian = Math.max(1, ...medians);

  return rows.map((r) => {
    const articleId = r.articleId == null ? null : Number(r.articleId);
    const uses = usesByArticle.get(articleId) ?? [];
    return {
      articleId,
      slug: r.slug,
      title: r.title ?? "Not matched to an article",
      dek: r.dek,
      author: r.author,
      publishedOn: r.publishedOn,
      canonicalUrl: r.canonicalUrl,
      xArticleUrl: r.xArticleUrl,
      kind: r.kind,
      product: r.product,
      productLabel: r.product ? productLabel(r.product) : null,
      useCount: r.useCount,
      firstUsed: r.firstUsed,
      lastUsed: r.lastUsed,
      daysSinceLastUse: r.daysSinceLastUse,
      totalImpr: r.totalImpr,
      medianImpr: r.medianImpr,
      bestImpr: r.bestImpr,
      avgEngRate: r.avgEngRate,
      score: reAmplifyScore(r, maxMedian),
      posts: uses,
    };
  });
}

// "Worth reaching for right now", 0..100. Performance is the base; a piece that
// has been used a lot recently is cooled off, and a piece that has rested is
// warmed back up. Deliberately NOT just impressions — the old shelf ranked on
// raw impressions alone, which kept pushing the same three articles.
function reAmplifyScore(r: ShelfSqlRow, maxMedian: number): number {
  const perf = (r.medianImpr ?? 0) / maxMedian; // 0..1
  const days = r.daysSinceLastUse;
  // Rest: nothing for a week, full credit by ~8 weeks.
  const rest = days == null ? 1 : Math.max(0, Math.min(1, (days - 7) / 49));
  // Fatigue: each use past the first shaves the ceiling, floored at 0.5.
  const fatigue = Math.max(0.5, 1 - (r.useCount - 1) * 0.08);
  return Math.round(Math.max(0, Math.min(100, (perf * 0.55 + rest * 0.45) * fatigue * 100)));
}

// Every article on file, newest first. Feeds the Product Posts targets and the
// article-match fallback.
export async function listArticles(kind?: "product" | "thought_leadership"): Promise<ArticleRow[]> {
  const rows = await sql<ArticleRow>`
    SELECT id, slug, title, dek, author,
           to_char(published_on, 'YYYY-MM-DD') AS "publishedOn",
           canonical_url AS "canonicalUrl", x_article_url AS "xArticleUrl",
           anchor_post_id AS "anchorPostId", kind, product, body
    FROM articles
    WHERE (${kind ?? null}::text IS NULL OR kind = ${kind ?? null})
    ORDER BY published_on DESC NULLS LAST
  `;
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}
