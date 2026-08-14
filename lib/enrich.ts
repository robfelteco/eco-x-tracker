import { sql } from "./db";
import { fetchArticleCard, fetchQuotedImage } from "./twitter";

/**
 * Link-preview enrichment.
 *
 * A large share of @eco's posts carry their substance behind an outbound link
 * rather than in the tweet text — external articles, eco.com blog posts, and
 * especially X's native long-form "Articles" (a t.co that opens an article whose
 * body is NOT in the tweet). Those article posts are exactly the ones the
 * classifier used to dump in review: the text field is a bare link.
 *
 * We resolve the link (following t.co redirects) and scrape its Open-Graph card
 * (title / description / image). That gives us (a) readable text to classify on,
 * and (b) a thumbnail image for the post. No billed API — just HTTP GETs — so
 * it's cheap enough to run on every new post during sync.
 *
 * We request with the classic OG-scraper User-Agent (facebookexternalhit); most
 * sites serve link-unfurl meta tags to it. Some news sites 403 that UA, so we
 * retry once with a normal Chrome UA.
 *
 * X's OWN native Articles are a special case: their page is auth-gated and serves
 * no usable card to any UA. For those we DON'T scrape — we read the article
 * straight from the X API (see fetchArticleCard / ingest). enrichByIds/backfill
 * detect an X-article link and take the API path instead.
 */

// Sites that block the scraper UA still tend to serve OG to a real browser UA.
const SCRAPER_UAS = [
  "facebookexternalhit/1.1 (+https://eco.com)",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];
const FETCH_TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 2_000_000; // don't slurp huge pages just to read <head>

export interface LinkCard {
  resolvedUrl: string;
  title: string | null;
  description: string | null;
  image: string | null;
}

// Tweet permalinks (x.com/user/status/123) — these are quote targets we already
// capture via is_quote; enriching them just re-surfaces another tweet's text.
function isStatusPermalink(u: string): boolean {
  return /(?:x|twitter)\.com\/[^/]+\/status\/\d+/i.test(u);
}

// X native long-form Articles: x.com/<user>/article/<id> or x.com/i/article/<id>.
export function isXArticle(u: string): boolean {
  return /(?:x|twitter)\.com\/(?:i\/)?(?:[^/]+\/)?article\/\d+/i.test(u);
}

/**
 * Choose which outbound URL on a post is worth enriching. Prefers X native
 * articles, then any non-permalink link (external article, eco.com blog, or an
 * unresolved t.co). Skips bare tweet permalinks (quotes) since they add nothing.
 */
export function pickEnrichUrl(urls: { url?: string; expanded_url?: string }[] | null | undefined): string | null {
  const cands = (urls ?? [])
    .map((u) => u.expanded_url || u.url || "")
    .filter((u) => /^https?:\/\//i.test(u));
  if (!cands.length) return null;
  const article = cands.find(isXArticle);
  if (article) return article;
  const nonPermalink = cands.find((u) => !isStatusPermalink(u));
  return nonPermalink ?? null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x2019;/gi, "’")
    .trim();
}

// Read the first content= value for any of `names` across the page's <meta> tags,
// tolerant of attribute order (property=… before or after content=…).
function metaContent(html: string, names: string[]): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const tag of tags) {
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!key || !wanted.has(key[1].toLowerCase())) continue;
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (content && content[1]) return decodeEntities(content[1]);
  }
  return null;
}

function titleTag(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]) : null;
}

function absolutize(img: string | null, base: string): string | null {
  if (!img) return null;
  try {
    return new URL(img, base).toString();
  } catch {
    return img;
  }
}

/**
 * Resolve a URL (following redirects) and scrape its OG/Twitter card. Returns
 * null on any failure — enrichment is always best-effort.
 */
export async function scrapeCard(url: string): Promise<LinkCard | null> {
  let lastResolved: string | null = null;
  for (const ua of SCRAPER_UAS) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml" },
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const resolvedUrl = res.url || url;
      lastResolved = resolvedUrl;
      // 403/401/429 usually mean this UA is blocked — try the next UA.
      if (res.status === 403 || res.status === 401 || res.status === 429) continue;

      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (!res.ok || (ct && !ct.includes("html"))) {
        // Non-HTML (a PDF, image, etc.) — nothing to unfurl, but keep the resolved URL.
        return { resolvedUrl, title: null, description: null, image: null };
      }

      // Cap how much we read; the card lives in <head>, so the first chunk is plenty.
      const buf = await res.arrayBuffer();
      const html = Buffer.from(buf.slice(0, MAX_HTML_BYTES)).toString("utf8");

      const title = metaContent(html, ["og:title", "twitter:title"]) || titleTag(html);
      const description = metaContent(html, ["og:description", "twitter:description", "description"]);
      const image = absolutize(
        metaContent(html, ["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"]),
        resolvedUrl,
      );

      // If this UA got HTML but no card at all, a different UA might do better.
      if (!title && !description && !image) continue;
      return { resolvedUrl, title, description, image };
    } catch {
      // timeout/network — try the next UA
    }
  }
  // Every UA failed to produce a card; keep whatever we resolved to, if anything.
  return lastResolved ? { resolvedUrl: lastResolved, title: null, description: null, image: null } : null;
}

async function writeCard(id: string, card: LinkCard): Promise<void> {
  await sql`
    UPDATE posts SET
      link_resolved_url = ${card.resolvedUrl},
      link_title        = ${card.title},
      link_description  = ${card.description},
      link_image_url    = ${card.image},
      enriched_at       = now(),
      updated_at        = now()
    WHERE id = ${id}`;
}

// Small concurrency pool so a batch of scrapes runs a few at a time.
async function pool<T>(items: T[], size: number, worker: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

interface EnrichRow {
  id: string;
  urls: { url?: string; expanded_url?: string }[];
}

/**
 * Enrich a specific set of posts (e.g. the ones just ingested). Only touches main
 * posts that have an enrichable outbound link and haven't been enriched yet.
 */
export async function enrichByIds(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const rows = await sql<EnrichRow>`
    SELECT id, urls FROM posts
    WHERE id = ANY(${ids}) AND is_reply = false AND enriched_at IS NULL`;
  return runEnrich(rows);
}

/**
 * Backfill: enrich stored main posts that carry a link but have no card yet.
 * Used by the one-shot backfill endpoint/script.
 */
export async function enrichUnenriched(limit = 200): Promise<{ scanned: number; enriched: number }> {
  const rows = await sql<EnrichRow>`
    SELECT id, urls FROM posts
    WHERE is_reply = false
      AND enriched_at IS NULL
      AND jsonb_array_length(urls) > 0
    ORDER BY created_at DESC
    LIMIT ${limit}`;
  const enriched = await runEnrich(rows);
  return { scanned: rows.length, enriched };
}

// Extract a quoted tweet's id from a post's outbound links (the quote permalink,
// x.com/<user>/status/<id>). We don't store the quoted id separately — the
// permalink in `urls` carries it.
function quotedTweetIdFromUrls(urls: { url?: string; expanded_url?: string }[] | null | undefined): string | null {
  for (const u of urls ?? []) {
    const m = /(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i.exec(u.expanded_url || u.url || "");
    if (m) return m[1];
  }
  return null;
}

/**
 * Fill quoted_image_url for QUOTE posts the timeline expansion couldn't resolve
 * for free — chiefly quotes of X native Articles, whose cover only resolves on a
 * direct fetch of the quoted tweet (see fetchQuotedImage). One billed read per
 * such post; scoped to the given ids and skipped once a quote already has an
 * image. `scanAll` backfills every unresolved quote post instead.
 */
export async function enrichQuotedImages(ids: string[], scanAll = false, limit = 200): Promise<number> {
  const rows = scanAll
    ? await sql<EnrichRow>`
        SELECT id, urls FROM posts
        WHERE is_reply = false AND is_quote = true AND quoted_image_url IS NULL
        ORDER BY created_at DESC LIMIT ${limit}`
    : ids.length
      ? await sql<EnrichRow>`
          SELECT id, urls FROM posts
          WHERE id = ANY(${ids}) AND is_reply = false AND is_quote = true AND quoted_image_url IS NULL`
      : [];
  const targets = rows
    .map((r) => ({ id: r.id, qid: quotedTweetIdFromUrls(r.urls) }))
    .filter((t): t is { id: string; qid: string } => !!t.qid);
  let n = 0;
  await pool(targets, 4, async ({ id, qid }) => {
    const img = await fetchQuotedImage(qid);
    if (img) {
      await sql`UPDATE posts SET quoted_image_url = ${img}, updated_at = now() WHERE id = ${id}`;
      n++;
    }
  });
  return n;
}

async function runEnrich(rows: EnrichRow[]): Promise<number> {
  let enriched = 0;
  const targets = rows
    .map((r) => ({ id: r.id, url: pickEnrichUrl(r.urls) }))
    .filter((t): t is { id: string; url: string } => !!t.url);

  await pool(targets, 5, async ({ id, url }) => {
    // X native article → read it from the API (the page is auth-gated). The
    // article is attached to THIS post's tweet id. External link → scrape OG.
    if (isXArticle(url)) {
      const art = await fetchArticleCard(id);
      if (art && (art.title || art.description || art.image)) {
        await writeCard(id, { resolvedUrl: url, ...art });
        enriched++;
      }
      return;
    }
    const card = await scrapeCard(url);
    if (card) {
      await writeCard(id, card);
      enriched++;
    }
  });
  return enriched;
}
