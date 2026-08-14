/**
 * X (Twitter) API v2 client — OAuth 1.0a user-context signing.
 *
 * The signing core is lifted verbatim from eco-x-studio/lib/twitter.ts (proven,
 * and user-context auth is required to read real impression_count + any
 * non_public_metrics). Adapted for the tracker:
 *   - ingestion KEEPS self-replies (marked), excludes only pure reposts;
 *   - captures media URLs + preview_image_url (needed for multimodal classify);
 *   - captures quote_count + bookmark_count;
 *   - 429 backoff honoring x-rate-limit-reset;
 *   - best-effort non_public_metrics (url_link_clicks, user_profile_clicks),
 *     only valid for posts <~30d old — failures are reported, never thrown.
 */
import crypto from "crypto";

const API_BASE = "https://api.twitter.com/2";

interface TwitterCreds {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

function getCreds(): TwitterCreds {
  const c = {
    consumerKey: process.env.TWITTER_CONSUMER_KEY || "",
    consumerSecret: process.env.TWITTER_CONSUMER_SECRET || "",
    accessToken: process.env.TWITTER_ACCESS_TOKEN || "",
    accessTokenSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET || "",
  };
  if (!c.consumerKey || !c.consumerSecret || !c.accessToken || !c.accessTokenSecret) {
    throw new Error("Twitter OAuth 1.0a creds missing in env (TWITTER_CONSUMER_KEY/SECRET, TWITTER_ACCESS_TOKEN/SECRET)");
  }
  return c;
}

// Two supported auth modes:
//   - "oauth1"  → OAuth 1.0a user context (needs all 4 TWITTER_* keys). Required
//                 for non_public_metrics (link/profile clicks) on the authed
//                 account's own posts.
//   - "bearer"  → OAuth 2.0 app-only (TWITTER_BEARER_TOKEN). Reads any public
//                 timeline + public_metrics (incl. impression_count/views), but
//                 CANNOT read non_public_metrics.
export type AuthMode = "oauth1" | "bearer";

export function authMode(): AuthMode {
  const hasOauth1 =
    process.env.TWITTER_CONSUMER_KEY &&
    process.env.TWITTER_CONSUMER_SECRET &&
    process.env.TWITTER_ACCESS_TOKEN &&
    process.env.TWITTER_ACCESS_TOKEN_SECRET;
  if (hasOauth1) return "oauth1";
  if (process.env.TWITTER_BEARER_TOKEN) return "bearer";
  throw new Error(
    "No X API creds. Set TWITTER_BEARER_TOKEN (app-only) or all 4 TWITTER_* OAuth 1.0a values (user context).",
  );
}

// Whether user-context reads (and thus non_public_metrics) are available.
export function userContextAvailable(): boolean {
  try {
    return authMode() === "oauth1";
  } catch {
    return false;
  }
}

function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function oauth1Header(method: string, url: string, params: Record<string, string>, creds: TwitterCreds): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };
  const allParams = { ...params, ...oauthParams };
  const paramStr = Object.keys(allParams)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(allParams[k])}`)
    .join("&");
  const baseString = [method.toUpperCase(), rfc3986(url), rfc3986(paramStr)].join("&");
  const signingKey = `${rfc3986(creds.consumerSecret)}&${rfc3986(creds.accessTokenSecret)}`;
  const signature = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");
  oauthParams.oauth_signature = signature;
  return (
    "OAuth " +
    Object.keys(oauthParams)
      .sort()
      .map((k) => `${rfc3986(k)}="${rfc3986(oauthParams[k])}"`)
      .join(", ")
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// X bills per RESOURCE returned (per post / per user lookup), not per HTTP call,
// so the cost meter counts resources at the call sites. apiCalls is kept for
// debugging only.
let apiCalls = 0;
let billedReads = 0;
function addBilled(n: number) {
  billedReads += n;
}
export function takeReadCount(): number {
  const n = billedReads;
  billedReads = 0;
  apiCalls = 0;
  return n;
}

async function apiGet<T>(path: string, params: Record<string, string>, attempt = 0): Promise<T> {
  const urlBase = `${API_BASE}${path}`;
  const queryString = Object.entries(params)
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join("&");
  const url = queryString ? `${urlBase}?${queryString}` : urlBase;

  const authorization =
    authMode() === "oauth1"
      ? oauth1Header("GET", urlBase, params, getCreds())
      : `Bearer ${process.env.TWITTER_BEARER_TOKEN}`;

  const res = await fetch(url, {
    headers: { Authorization: authorization, "User-Agent": "eco-x-tracker/1.0" },
    cache: "no-store",
  });

  // 429 backoff — honor x-rate-limit-reset (epoch seconds), cap the wait, retry.
  if (res.status === 429 && attempt < 4) {
    const resetHdr = Number(res.headers.get("x-rate-limit-reset") || 0);
    const waitMs = resetHdr ? Math.max(0, resetHdr * 1000 - Date.now()) : 2000 * 2 ** attempt;
    const cappedMs = Math.min(waitMs + 500, 60_000); // never sleep more than ~1min per attempt
    await sleep(cappedMs);
    return apiGet<T>(path, params, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text();
    let hint = "";
    if (res.status === 402 || /CreditsDepleted/i.test(body)) hint = " — X API credits depleted; needs a top-up.";
    else if (res.status === 403 && /SpendCapReached/i.test(body)) hint = " — X API monthly spend cap reached.";
    else if (res.status === 401) hint = " — OAuth rejected; verify the 4 TWITTER_* env vars.";
    throw new Error(`Twitter API ${res.status}${hint}: ${body.slice(0, 400)}`);
  }
  apiCalls++;
  return (await res.json()) as T;
}

// Twitter returns HTML-encoded text — decode for storage/display.
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

export type MediaType = "video" | "photo" | "animated_gif" | "link-card" | "text";

export interface XPost {
  id: string;
  url: string;
  created_at: string;
  text: string;
  urls: { url: string; expanded_url: string; domain: string }[];
  domains: string[];
  mentions: string[];
  hashtags: string[];
  mediaType: MediaType;
  media_urls: string[];
  preview_image_url: string | null;
  is_reply: boolean;
  is_self_reply: boolean;
  is_quote: boolean;
  // X native long-form Article attached to this post, if any. The tweet text of
  // an article post is usually just a t.co link — the real content is here, read
  // straight from the API (tweet.fields=article) so we never have to scrape X's
  // auth-gated article page. Fills the link_* columns at ingest.
  link_title: string | null;
  link_description: string | null;
  link_image_url: string | null;
  // For a QUOTE post, the visual the reader sees is the quoted tweet's own
  // image — a native photo/video poster, or (when the quoted tweet is itself an
  // X native Article) its cover image. The quoting post rarely repeats it, so we
  // pull it from the referenced-tweet expansion and use it as the thumbnail.
  quoted_image_url: string | null;
  // public_metrics returned inline with the timeline — used as the first
  // snapshot so we don't pay to re-read a post we just fetched.
  metrics: PublicMetrics;
}

export interface PublicMetrics {
  id: string;
  impressions: number;
  likes: number;
  replies: number;
  retweets: number;
  quotes: number;
  bookmarks: number;
}

export interface NonPublicMetrics {
  id: string;
  url_link_clicks: number | null;
  user_profile_clicks: number | null;
}

interface RawTweet {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  in_reply_to_user_id?: string;
  public_metrics?: {
    like_count?: number;
    retweet_count?: number;
    reply_count?: number;
    impression_count?: number;
    quote_count?: number;
    bookmark_count?: number;
  };
  non_public_metrics?: { url_link_clicks?: number; user_profile_clicks?: number };
  referenced_tweets?: { type: string; id: string }[];
  attachments?: { media_keys?: string[] };
  note_tweet?: { text?: string; entities?: RawEntities };
  article?: {
    title?: string;
    preview_text?: string; // short summary
    plain_text?: string; // full body
    cover_media?: string; // media_key → resolve via includes.media
  };
  entities?: RawEntities;
}

interface RawEntities {
  urls?: { expanded_url?: string; url?: string }[];
  mentions?: { username: string }[];
  hashtags?: { tag: string }[];
}

interface RawMedia {
  media_key: string;
  type: string; // photo | video | animated_gif
  url?: string; // photos
  preview_image_url?: string; // video/gif thumbnail
  variants?: { bit_rate?: number; content_type?: string; url?: string }[]; // video renditions
}

function domainOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

// Resolve @handle -> numeric id. Memoized per-process (id is immutable enough;
// a rename self-heals on cold start). One user read, ~$0.01.
const handleMemo = new Map<string, { id: string; username: string }>();
export async function resolveHandle(handle: string): Promise<{ id: string; username: string }> {
  const clean = handle.replace(/^@/, "").toLowerCase();
  const cached = handleMemo.get(clean);
  if (cached) return cached;
  const data = await apiGet<{ data?: { id: string; username: string } }>(`/users/by/username/${clean}`, {
    "user.fields": "id,username",
  });
  if (!data.data) throw new Error(`Handle not found: @${clean}`);
  addBilled(1); // one user lookup
  const resolved = { id: data.data.id, username: data.data.username };
  handleMemo.set(clean, resolved);
  return resolved;
}

// Best image on a single tweet: a native photo, else a video/GIF poster, else
// (when the tweet is an X native Article) its cover image. Used both for the
// main post and for the quoted tweet behind a quote post.
function imageOnTweet(t: RawTweet, mediaMap: Map<string, RawMedia>): string | null {
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

// Long-form posts (note_tweet) carry their FULL entities in note_tweet.entities,
// while the top-level entities only cover the truncated 280-char preview — so a
// link past the cutoff (the classic "…\n\nhttps://t.co/…" article/doc link) is
// absent from t.entities. Neither set is a strict superset (the quoted-tweet
// t.co often sits only in the top-level set), so we MERGE both and dedupe.
function mergedEntities(t: RawTweet): Required<RawEntities> {
  const a = t.entities ?? {};
  const b = t.note_tweet?.entities ?? {};
  const urlKey = (u: { expanded_url?: string; url?: string }) => u.expanded_url || u.url || "";
  const urls = [...(a.urls ?? []), ...(b.urls ?? [])];
  const seenUrl = new Set<string>();
  const dedupUrls = urls.filter((u) => {
    const k = urlKey(u);
    if (!k || seenUrl.has(k)) return false;
    seenUrl.add(k);
    return true;
  });
  return {
    urls: dedupUrls,
    mentions: [...(a.mentions ?? []), ...(b.mentions ?? [])],
    hashtags: [...(a.hashtags ?? []), ...(b.hashtags ?? [])],
  };
}

function mapRawToPost(
  t: RawTweet,
  mediaMap: Map<string, RawMedia>,
  quotedMap: Map<string, RawTweet>,
  selfUserId: string,
): XPost {
  const keys = t.attachments?.media_keys ?? [];
  const media = keys.map((k) => mediaMap.get(k)).filter(Boolean) as RawMedia[];
  const types = media.map((m) => m.type);
  const ent = mergedEntities(t);

  let mediaType: MediaType = "text";
  if (types.includes("video")) mediaType = "video";
  else if (types.includes("animated_gif")) mediaType = "animated_gif";
  else if (types.includes("photo")) mediaType = "photo";
  else if (ent.urls.length) mediaType = "link-card";

  const media_urls: string[] = [];
  let preview_image_url: string | null = null;
  for (const m of media) {
    if (m.type === "photo" && m.url) media_urls.push(m.url);
    if ((m.type === "video" || m.type === "animated_gif") && m.preview_image_url) {
      preview_image_url = preview_image_url || m.preview_image_url;
    }
    if (m.type === "video" && m.variants?.length) {
      const best = m.variants
        .filter((v) => v.content_type === "video/mp4" && v.url)
        .sort((a, b) => (b.bit_rate ?? 0) - (a.bit_rate ?? 0))[0];
      if (best?.url) media_urls.push(best.url);
    }
  }

  const refs = t.referenced_tweets ?? [];
  const is_quote = refs.some((r) => r.type === "quoted");
  const is_reply = refs.some((r) => r.type === "replied_to") || !!t.in_reply_to_user_id;
  const is_self_reply = is_reply && t.in_reply_to_user_id === selfUserId;

  // Thumbnail for a quote post: the quoted tweet's own image (native media or,
  // if it's an X native Article, its cover). Resolved from the referenced-tweet
  // expansion; null when the quote has no visual of its own.
  const quotedRef = refs.find((r) => r.type === "quoted");
  const quotedTweet = quotedRef ? quotedMap.get(quotedRef.id) : undefined;
  const quoted_image_url = quotedTweet ? imageOnTweet(quotedTweet, mediaMap) : null;

  const urls = ent.urls
    .map((u) => {
      const expanded = u.expanded_url || u.url || "";
      return { url: u.url || expanded, expanded_url: expanded, domain: domainOf(expanded) };
    })
    .filter((u) => u.expanded_url);

  // X native Article attached to this post — read its title/summary/cover from
  // the API rather than scraping X's auth-gated article page.
  let link_title: string | null = null;
  let link_description: string | null = null;
  let link_image_url: string | null = null;
  if (t.article) {
    const cover = t.article.cover_media ? mediaMap.get(t.article.cover_media) : undefined;
    link_title = t.article.title ? decodeEntities(t.article.title) : null;
    const body = t.article.preview_text || t.article.plain_text || "";
    link_description = body ? decodeEntities(body).slice(0, 600) : null;
    link_image_url = cover?.url || cover?.preview_image_url || null;
  }

  return {
    id: t.id,
    url: `https://x.com/i/status/${t.id}`,
    created_at: t.created_at || "",
    text: decodeEntities(t.note_tweet?.text || t.text),
    urls,
    domains: [...new Set(urls.map((u) => u.domain).filter(Boolean))],
    mentions: [...new Set(ent.mentions.map((m) => m.username.toLowerCase()))],
    hashtags: [...new Set(ent.hashtags.map((h) => h.tag))],
    mediaType,
    media_urls: [...new Set(media_urls)],
    preview_image_url,
    is_reply,
    is_self_reply,
    is_quote,
    link_title,
    link_description,
    link_image_url,
    quoted_image_url,
    metrics: {
      id: t.id,
      impressions: t.public_metrics?.impression_count ?? 0,
      likes: t.public_metrics?.like_count ?? 0,
      replies: t.public_metrics?.reply_count ?? 0,
      retweets: t.public_metrics?.retweet_count ?? 0,
      quotes: t.public_metrics?.quote_count ?? 0,
      bookmarks: t.public_metrics?.bookmark_count ?? 0,
    },
  };
}

const TWEET_FIELDS =
  "created_at,public_metrics,referenced_tweets,text,entities,attachments,note_tweet,in_reply_to_user_id,author_id,article";
const MEDIA_FIELDS = "type,url,preview_image_url,variants";
// Also expand the quoted tweet (referenced_tweets.id) and ITS media/article
// cover, so a quote post can borrow the quoted tweet's image as its thumbnail.
const EXPANSIONS =
  "attachments.media_keys,article.cover_media,referenced_tweets.id,referenced_tweets.id.attachments.media_keys,referenced_tweets.id.article.cover_media";

export interface FetchOpts {
  count?: number; // hard cap on posts returned
  sinceId?: string; // incremental: only posts newer than this id
  startTime?: string; // ISO8601 lower time bound (e.g. "2026-01-01T00:00:00Z")
  maxPages?: number; // safety cap on pagination (100/page)
}

/**
 * Fetch the account timeline. Excludes reposts (retweets) AND replies — we track
 * only MAIN posts. Replies are redundant or off-topic: a thread is already
 * represented by its first post (a self-reply just continues it), and replies to
 * other accounts aren't our own standalone content. Quotes are kept (a quote is a
 * standalone main post). The API reaches ~3,200 most-recent posts; page with
 * pagination_token up to maxPages.
 */
export async function fetchUserTweets(userId: string, opts: FetchOpts = {}): Promise<XPost[]> {
  const count = opts.count ?? 100;
  const maxPages = opts.maxPages ?? 40;
  const results: XPost[] = [];
  let paginationToken: string | undefined;
  let pages = 0;

  while (pages++ < maxPages) {
    const params: Record<string, string> = {
      max_results: "100",
      exclude: "retweets,replies", // main posts only — drop reposts AND all replies (self + others)
      "tweet.fields": TWEET_FIELDS,
      "media.fields": MEDIA_FIELDS,
      expansions: EXPANSIONS,
    };
    if (opts.sinceId) params.since_id = opts.sinceId;
    if (opts.startTime) params.start_time = opts.startTime;
    if (paginationToken) params.pagination_token = paginationToken;

    const data = await apiGet<{
      data?: RawTweet[];
      includes?: { media?: RawMedia[]; tweets?: RawTweet[] };
      meta?: { next_token?: string };
    }>(`/users/${userId}/tweets`, params);

    const tweets = data.data || [];
    if (!tweets.length) break;
    addBilled(tweets.length); // X bills per post in `data`; expanded includes are free

    const mediaMap = new Map<string, RawMedia>();
    for (const m of data.includes?.media ?? []) mediaMap.set(m.media_key, m);
    // Quoted tweets arrive as expansions in includes.tweets (not billed).
    const quotedMap = new Map<string, RawTweet>();
    for (const qt of data.includes?.tweets ?? []) quotedMap.set(qt.id, qt);

    for (const t of tweets) {
      results.push(mapRawToPost(t, mediaMap, quotedMap, userId));
      if (results.length >= count) return results;
    }

    paginationToken = data.meta?.next_token;
    if (!paginationToken) break;
  }
  return results;
}

// Batch current public metrics for up to 100 ids.
export async function fetchPublicMetrics(ids: string[]): Promise<PublicMetrics[]> {
  if (!ids.length) return [];
  const data = await apiGet<{ data?: RawTweet[] }>("/tweets", {
    ids: ids.slice(0, 100).join(","),
    "tweet.fields": "public_metrics",
  });
  addBilled((data.data || []).length);
  return (data.data || []).map((t) => ({
    id: t.id,
    impressions: t.public_metrics?.impression_count ?? 0,
    likes: t.public_metrics?.like_count ?? 0,
    replies: t.public_metrics?.reply_count ?? 0,
    retweets: t.public_metrics?.retweet_count ?? 0,
    quotes: t.public_metrics?.quote_count ?? 0,
    bookmarks: t.public_metrics?.bookmark_count ?? 0,
  }));
}

/**
 * Best-effort non_public_metrics for up to 100 ids. Only valid for the
 * authenticated account's own posts <~30d old — for older posts X errors the
 * whole request, so callers should pass only recent ids. Returns [] on failure
 * (recorded as unavailable) rather than throwing.
 */
export async function fetchNonPublicMetrics(ids: string[]): Promise<NonPublicMetrics[]> {
  if (!ids.length) return [];
  // non_public_metrics requires user context; app-only bearer can't read them.
  if (!userContextAvailable()) return [];
  try {
    const data = await apiGet<{ data?: RawTweet[] }>("/tweets", {
      ids: ids.slice(0, 100).join(","),
      "tweet.fields": "non_public_metrics",
    });
    addBilled((data.data || []).length);
    return (data.data || []).map((t) => ({
      id: t.id,
      url_link_clicks: t.non_public_metrics?.url_link_clicks ?? null,
      user_profile_clicks: t.non_public_metrics?.user_profile_clicks ?? null,
    }));
  } catch {
    return []; // unavailable (too old / not permitted) — caller records the gap
  }
}

/**
 * Resolve a QUOTED tweet's image by fetching it directly (one billed read).
 * The timeline's nested referenced_tweets expansion resolves a quoted tweet's
 * NATIVE media (photo/video poster) for free — but NOT the cover image of a
 * quoted X native Article: the API returns the cover's media_key without the
 * media object. Fetching the quoted tweet on its own DOES resolve it into
 * includes.media. Used as a fallback for quote-of-article posts. Returns null
 * if the quote has no image of its own or the read fails.
 */
export async function fetchQuotedImage(quotedTweetId: string): Promise<string | null> {
  try {
    const data = await apiGet<{ data?: RawTweet; includes?: { media?: RawMedia[] } }>(`/tweets/${quotedTweetId}`, {
      "tweet.fields": "attachments,article",
      expansions: "attachments.media_keys,article.cover_media",
      "media.fields": MEDIA_FIELDS,
    });
    addBilled(1);
    if (!data.data) return null;
    const mediaMap = new Map<string, RawMedia>();
    for (const m of data.includes?.media ?? []) mediaMap.set(m.media_key, m);
    return imageOnTweet(data.data, mediaMap);
  } catch {
    return null;
  }
}

export interface ArticleCard {
  title: string | null;
  description: string | null;
  image: string | null;
}

/**
 * Fetch the X native Article attached to a single post (by tweet id), reading
 * title / summary / cover image straight from the API. Used to backfill article
 * posts already in the DB (fresh ingests get the article inline with the
 * timeline). Returns null if the post has no article or the read fails.
 */
export async function fetchArticleCard(tweetId: string): Promise<ArticleCard | null> {
  try {
    const data = await apiGet<{ data?: RawTweet; includes?: { media?: RawMedia[] } }>(`/tweets/${tweetId}`, {
      "tweet.fields": "article",
      expansions: "article.cover_media",
      "media.fields": MEDIA_FIELDS,
    });
    addBilled(1);
    const art = data.data?.article;
    if (!art) return null;
    const mediaMap = new Map<string, RawMedia>();
    for (const m of data.includes?.media ?? []) mediaMap.set(m.media_key, m);
    const cover = art.cover_media ? mediaMap.get(art.cover_media) : undefined;
    const body = art.preview_text || art.plain_text || "";
    return {
      title: art.title ? decodeEntities(art.title) : null,
      description: body ? decodeEntities(body).slice(0, 600) : null,
      image: cover?.url || cover?.preview_image_url || null,
    };
  } catch {
    return null;
  }
}
