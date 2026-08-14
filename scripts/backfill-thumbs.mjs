/**
 * One-shot repair for existing rows, matching the ingest fixes in lib/twitter.ts:
 *   A) QUOTE posts — pull the quoted tweet's image (native media or X-article
 *      cover) into quoted_image_url.
 *   B) LONG-FORM posts whose outbound link lived only in note_tweet.entities and
 *      was dropped at ingest (urls empty) — recapture the link, mark it a
 *      link-card, scrape its OG card so it gets a thumbnail + readable title.
 *
 * Fresh ingests get all of this inline now; this only backfills history.
 * Uses the app-only bearer token (no OAuth1 access tokens are configured).
 * Run: node --env-file=.env scripts/backfill-thumbs.mjs
 */
import pg from "pg";

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
const client = new pg.Client({ connectionString: url, ssl: url.includes("localhost") ? false : { rejectUnauthorized: false } });
await client.connect();

const API_BASE = "https://api.twitter.com/2";
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
async function apiGet(path, params) {
  const qs = Object.entries(params).map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).join("&");
  const res = await fetch(`${API_BASE}${path}?${qs}`, { headers: { Authorization: `Bearer ${process.env.TWITTER_BEARER_TOKEN}` } });
  if (!res.ok) throw new Error(`X ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const TWEET_FIELDS = "referenced_tweets,text,entities,attachments,note_tweet,article";
const EXPANSIONS =
  "attachments.media_keys,article.cover_media,referenced_tweets.id,referenced_tweets.id.attachments.media_keys,referenced_tweets.id.article.cover_media";
const MEDIA_FIELDS = "type,url,preview_image_url,variants";

const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const isPermalink = (u) => /(?:x|twitter)\.com\/[^/]+\/status\/\d+/i.test(u);
const isXArticle = (u) => /(?:x|twitter)\.com\/(?:i\/)?(?:[^/]+\/)?article\/\d+/i.test(u);

// --- mirrors lib/twitter.ts imageOnTweet / mergedEntities ---
function imageOnTweet(t, mediaMap) {
  for (const k of t.attachments?.media_keys ?? []) {
    const m = mediaMap.get(k);
    if (!m) continue;
    if (m.type === "photo" && m.url) return m.url;
    if ((m.type === "video" || m.type === "animated_gif") && m.preview_image_url) return m.preview_image_url;
  }
  if (t.article?.cover_media) {
    const cover = mediaMap.get(t.article.cover_media);
    if (cover?.url || cover?.preview_image_url) return cover.url || cover.preview_image_url || null;
  }
  return null;
}
function mergedEntities(t) {
  const a = t.entities ?? {}, b = t.note_tweet?.entities ?? {};
  const key = (u) => u.expanded_url || u.url || "";
  const seen = new Set();
  const urls = [...(a.urls ?? []), ...(b.urls ?? [])].filter((u) => { const k = key(u); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  return { urls };
}

// --- minimal OG scraper (mirrors lib/enrich.ts scrapeCard) ---
const SCRAPER_UAS = [
  "facebookexternalhit/1.1 (+https://eco.com)",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];
function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'").replace(/&nbsp;/g, " ").replace(/&#x2019;/gi, "’").trim();
}
function metaContent(html, names) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const tag of tags) {
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!key || !wanted.has(key[1].toLowerCase())) continue;
    const c = /content\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (c && c[1]) return decodeEntities(c[1]);
  }
  return null;
}
function absolutize(img, base) { if (!img) return null; try { return new URL(img, base).toString(); } catch { return img; } }
async function scrapeCard(link) {
  let lastResolved = null;
  for (const ua of SCRAPER_UAS) {
    try {
      const res = await fetch(link, { headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml" }, redirect: "follow", signal: AbortSignal.timeout(10000) });
      const resolvedUrl = res.url || link; lastResolved = resolvedUrl;
      if ([401, 403, 429].includes(res.status)) continue;
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (!res.ok || (ct && !ct.includes("html"))) return { resolvedUrl, title: null, description: null, image: null };
      const html = Buffer.from((await res.arrayBuffer()).slice(0, 2_000_000)).toString("utf8");
      const title = metaContent(html, ["og:title", "twitter:title"]) || (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ? decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)[1]) : null);
      const description = metaContent(html, ["og:description", "twitter:description", "description"]);
      const image = absolutize(metaContent(html, ["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"]), resolvedUrl);
      if (!title && !description && !image) continue;
      return { resolvedUrl, title, description, image };
    } catch { /* try next UA */ }
  }
  return lastResolved ? { resolvedUrl: lastResolved, title: null, description: null, image: null } : null;
}

// --- select candidates ---
const { rows: candidates } = await client.query(`
  SELECT id, is_quote, jsonb_array_length(urls) AS urlcount, media_type, enriched_at
  FROM posts
  WHERE is_reply = false
    AND ( (is_quote = true AND quoted_image_url IS NULL)
       OR jsonb_array_length(urls) = 0 )
  ORDER BY created_at DESC`);
console.log(`Candidates: ${candidates.length}`);
const byId = new Map(candidates.map((r) => [r.id, r]));
const ids = candidates.map((r) => r.id);

let quotedFixed = 0, linkFixed = 0, scraped = 0, apiReads = 0;

for (let i = 0; i < ids.length; i += 100) {
  const batch = ids.slice(i, i + 100);
  const data = await apiGet("/tweets", { ids: batch.join(","), "tweet.fields": TWEET_FIELDS, expansions: EXPANSIONS, "media.fields": MEDIA_FIELDS });
  apiReads += (data.data || []).length;
  const mediaMap = new Map((data.includes?.media ?? []).map((m) => [m.media_key, m]));
  const quotedMap = new Map((data.includes?.tweets ?? []).map((t) => [t.id, t]));

  for (const t of data.data || []) {
    const cand = byId.get(t.id);
    if (!cand) continue;

    // A) quoted image
    if (cand.is_quote) {
      const q = (t.referenced_tweets ?? []).find((r) => r.type === "quoted");
      const qt = q ? quotedMap.get(q.id) : undefined;
      const img = qt ? imageOnTweet(qt, mediaMap) : null;
      if (img) {
        await client.query(`UPDATE posts SET quoted_image_url = $1, updated_at = now() WHERE id = $2`, [img, t.id]);
        quotedFixed++;
      }
    }

    // B) recapture a dropped long-form link + scrape its card
    if (Number(cand.urlcount) === 0) {
      const ent = mergedEntities(t);
      const urls = ent.urls.map((u) => { const ex = u.expanded_url || u.url || ""; return { url: u.url || ex, expanded_url: ex, domain: domainOf(ex) }; }).filter((u) => u.expanded_url);
      const outbound = urls.map((u) => u.expanded_url).filter((u) => /^https?:/i.test(u) && !isPermalink(u));
      if (urls.length) {
        const domains = [...new Set(urls.map((u) => u.domain).filter(Boolean))];
        await client.query(
          `UPDATE posts SET urls = $1, domains = $2, media_type = CASE WHEN media_type = 'text' THEN 'link-card' ELSE media_type END, updated_at = now() WHERE id = $3`,
          [JSON.stringify(urls), domains, t.id],
        );
        linkFixed++;
        // scrape the enrichable (non-permalink, non-X-article) link for a card
        const enrichUrl = outbound.find(isXArticle) || outbound[0];
        if (enrichUrl && !isXArticle(enrichUrl)) {
          const card = await scrapeCard(enrichUrl);
          if (card && (card.title || card.image || card.description)) {
            await client.query(
              `UPDATE posts SET link_resolved_url = $1, link_title = COALESCE($2, link_title), link_description = COALESCE($3, link_description), link_image_url = COALESCE($4, link_image_url), enriched_at = now(), updated_at = now() WHERE id = $5`,
              [card.resolvedUrl, card.title, card.description, card.image, t.id],
            );
            if (card.image) scraped++;
          }
        }
      }
    }
  }
  console.log(`  batch ${i / 100 + 1}: quotedFixed=${quotedFixed} linkFixed=${linkFixed} scraped=${scraped}`);
}

// C) Quote posts still missing an image — chiefly quotes of X native Articles,
// whose cover only resolves on a DIRECT fetch of the quoted tweet. The quoted
// tweet id lives in the quote permalink inside `urls`.
const { rows: stillMissing } = await client.query(`
  SELECT id, urls FROM posts
  WHERE is_reply = false AND is_quote = true AND quoted_image_url IS NULL`);
const quotedIdOf = (urls) => {
  for (const u of urls ?? []) { const m = /(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i.exec(u.expanded_url || u.url || ""); if (m) return m[1]; }
  return null;
};
let coverFixed = 0;
for (const r of stillMissing) {
  const qid = quotedIdOf(r.urls);
  if (!qid) continue;
  const d = await apiGet(`/tweets/${qid}`, { "tweet.fields": "attachments,article", expansions: "attachments.media_keys,article.cover_media", "media.fields": MEDIA_FIELDS }).catch(() => null);
  apiReads++;
  if (!d?.data) continue;
  const mm = new Map((d.includes?.media ?? []).map((m) => [m.media_key, m]));
  const img = imageOnTweet(d.data, mm);
  if (img) {
    await client.query(`UPDATE posts SET quoted_image_url = $1, updated_at = now() WHERE id = $2`, [img, r.id]);
    coverFixed++;
  }
}
console.log(`Part C (direct quoted fetch): ${stillMissing.length} scanned, ${coverFixed} covers resolved`);

console.log(`\nDone. API reads=${apiReads} | quoted images set=${quotedFixed} | quoted covers set=${coverFixed} | links recaptured=${linkFixed} | OG images scraped=${scraped}`);
await client.end();
