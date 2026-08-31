import { sql } from "./db.ts";
import { icpFromSolutionsPath, ICP_BY_ID, TIER_ORDER, type DocTier } from "./icp.ts";

// The DOCS PAGE layer — the shelf behind the Dev Doc Post pillar.
//
// Every dev-doc post is built around a SECTION of docs.eco.com, not around the
// docs site as a whole. The corpus proves it and also proves the failure mode:
// of 25 logged dev-doc posts, 7 pointed at docs.eco.com/home and ran a 460
// median impression, while the 10 that deep-linked a specific page ran 934.
// Reaching for the homepage is the pillar's single most expensive habit.
//
// The shelf seeds itself. docs.eco.com publishes llms.txt — a curated,
// section-grouped index of every page, each with a one-line description written
// by the docs team — plus an .md twin of every page. So we get structure,
// blurbs and bodies from the docs site itself, re-synced on the normal cron. No
// scraping, no hand-maintained list that goes stale the moment docs ship.
//
// NOTE ON DIRECTION: unlike getArticleShelf, this shelf is built registry-first
// (doc_pages LEFT JOIN posts), not posts-first. The entire value here is the
// pages we have NEVER used — 66 of 73 at the time of writing. A posts-first
// grouping would show only the 7 we already reach for, which is exactly the rut
// this is meant to break.

export const DOCS_ORIGIN = "https://docs.eco.com";
export const LLMS_TXT_URL = `${DOCS_ORIGIN}/llms.txt`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocPageRow {
  id: number;
  url: string;
  path: string;
  section: string;
  title: string;
  blurb: string | null;
  body: string | null;
  icp: string | null;
  tier: DocTier | null;
  hook: string | null;
  active: boolean;
}

// One row per DOCS PAGE — the aggregate across every @eco post that drove to it.
// useCount 0 is the interesting case, not an empty state.
export interface DocShelfRow {
  docPageId: number | null; // null = the residual "docs post with no page" group
  url: string | null;
  path: string | null;
  section: string | null;
  title: string;
  blurb: string | null;
  hook: string | null;
  icp: string | null;
  icpLabel: string | null;
  tier: DocTier | null;
  useCount: number;
  lastUsed: string | null;
  daysSinceLastUse: number | null;
  medianImpr: number | null;
  bestImpr: number | null;
  score: number;
  posts: DocUse[];
}

export interface DocUse {
  id: string;
  url: string;
  createdAt: string;
  daysAgo: number;
  text: string;
  mediaType: string;
  impressions: number | null;
}

// ---------------------------------------------------------------------------
// llms.txt — parse
// ---------------------------------------------------------------------------

export interface ParsedDocPage {
  url: string;
  path: string;
  section: string;
  title: string;
  blurb: string | null;
}

// llms.txt is markdown with "## Section" headings and "- [Title](url.md): blurb"
// entries. We keep only docs.eco.com pages: the file also lists the Discord, a
// mailto:, portal.eco.com and the raw OpenAPI JSON specs, none of which are a
// page anyone can build a post around.
export function parseLlmsTxt(txt: string): ParsedDocPage[] {
  const out: ParsedDocPage[] = [];
  let section = "Uncategorized";
  const seen = new Set<string>();

  for (const raw of txt.split("\n")) {
    const line = raw.trimEnd();
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    const entry = line.match(/^-\s*\[([^\]]+)\]\(([^)]+)\)\s*(?::\s*(.*))?$/);
    if (!entry) continue;

    const [, title, href, blurb] = entry;
    if (!href.startsWith(`${DOCS_ORIGIN}/`)) continue; // external / mailto / portal
    if (/\.json($|\?)/i.test(href)) continue; // raw OpenAPI specs

    const url = canonicalDocUrl(href);
    if (!url || seen.has(url)) continue;
    seen.add(url);

    out.push({
      url,
      path: url.slice(DOCS_ORIGIN.length) || "/",
      section,
      title: title.trim(),
      blurb: blurb?.trim() || null,
    });
  }
  return out;
}

// Strip the .md twin suffix, any query string, and a trailing slash so a post's
// link_resolved_url and an llms.txt href collapse to the same key. Buffer adds
// ?utm_content=... to every link it posts, which is why the query has to go.
export function canonicalDocUrl(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (!/(^|\.)docs\.eco\.com$/i.test(u.hostname)) return null;
  let path = u.pathname.replace(/\.md$/i, "").replace(/\/+$/, "");
  if (path === "") path = "/home";
  return `${DOCS_ORIGIN}${path}`;
}

// Pages that real posts point at but llms.txt does not index. /home is the one
// that matters: seven dev-doc posts drove to the docs homepage and ran a 460
// median against 934 for deep links, and it is the pillar's most expensive
// habit. If we left it out of the registry those seven posts would fall into
// the residual "no page link" row, which hides the very pattern the shelf
// exists to break. Seeded as a real row, tiered 'reference' by hand so it
// scores 0 and is never recommended, but its use count stays visible.
const SYNTHETIC_PAGES: ParsedDocPage[] = [
  {
    url: `${DOCS_ORIGIN}/home`,
    path: "/home",
    section: "Get started",
    title: "Docs homepage",
    blurb:
      "The docs landing page. Not indexed in llms.txt and not a post subject — deep-link a specific section instead.",
  },
];

const SYNTHETIC_REFERENCE_PATHS = new Set(SYNTHETIC_PAGES.map((p) => p.path));

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export interface DocsSyncResult {
  fetched: number;
  inserted: number;
  updated: number;
  deactivated: number;
  bodiesFetched: number;
  errors: string[];
}

// Pull llms.txt, upsert every page, then fetch the .md body for any page that
// doesn't have one yet. Deactivates pages that have dropped out of the index
// rather than deleting them, so a post that used a since-retired page keeps its
// attribution.
export async function syncDocPages(opts: { withBodies?: boolean } = {}): Promise<DocsSyncResult> {
  const res: DocsSyncResult = {
    fetched: 0,
    inserted: 0,
    updated: 0,
    deactivated: 0,
    bodiesFetched: 0,
    errors: [],
  };

  const txtRes = await fetch(LLMS_TXT_URL, { signal: AbortSignal.timeout(30_000) });
  if (!txtRes.ok) throw new Error(`llms.txt ${txtRes.status}`);
  const pages = parseLlmsTxt(await txtRes.text());
  res.fetched = pages.length;
  if (!pages.length) throw new Error("llms.txt parsed to zero pages — refusing to deactivate everything");
  pages.push(...SYNTHETIC_PAGES);

  for (const p of pages) {
    // A /solutions/<slug> page names its own persona, so tag it for free rather
    // than paying Claude to read what the URL already says.
    const autoIcp = icpFromSolutionsPath(p.path);
    // A synthetic page is pre-judged: it exists to be counted, never recommended.
    const isSynthetic = SYNTHETIC_REFERENCE_PATHS.has(p.path);
    const seedTier = isSynthetic ? "reference" : null;
    const seedSource = isSynthetic ? "human" : autoIcp ? "path" : null;
    const rows = await sql<{ inserted: boolean }>`
      INSERT INTO doc_pages (url, path, section, title, blurb, icp, tier, hook, tag_source, tagged_at, active)
      VALUES (
        ${p.url}, ${p.path}, ${p.section}, ${p.title}, ${p.blurb},
        ${autoIcp}, ${seedTier},
        ${isSynthetic ? "No post here — deep-link a specific docs section instead." : null},
        ${seedSource}, ${seedSource ? new Date().toISOString() : null}, true
      )
      ON CONFLICT (url) DO UPDATE SET
        path = EXCLUDED.path,
        section = EXCLUDED.section,
        title = EXCLUDED.title,
        blurb = COALESCE(EXCLUDED.blurb, doc_pages.blurb),
        -- never clobber a human or Claude tag with the cheap path guess
        icp = CASE WHEN doc_pages.icp IS NULL THEN EXCLUDED.icp ELSE doc_pages.icp END,
        active = true,
        updated_at = now()
      RETURNING (xmax = 0) AS inserted`;
    if (rows[0]?.inserted) res.inserted++;
    else res.updated++;
  }

  const urls = pages.map((p) => p.url);
  const gone = await sql<{ id: number }>`
    UPDATE doc_pages SET active = false, updated_at = now()
    WHERE active = true AND NOT (url = ANY(${urls}))
    RETURNING id`;
  res.deactivated = gone.length;

  if (opts.withBodies !== false) {
    const need = await sql<{ id: number; url: string }>`
      SELECT id, url FROM doc_pages WHERE active = true AND body IS NULL ORDER BY id`;
    for (const row of need) {
      try {
        const body = await fetchDocBody(row.url);
        if (body) {
          await sql`UPDATE doc_pages SET body = ${body}, body_fetched_at = now(), updated_at = now() WHERE id = ${row.id}`;
          res.bodiesFetched++;
        }
      } catch (e) {
        res.errors.push(`${row.url}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return res;
}

// Every docs page has a .md twin that returns clean markdown — no HTML parsing,
// no Firecrawl credits. The file opens with a three-line "Documentation Index"
// preamble pointing at llms.txt, which is noise in a drafting prompt, so it goes.
export async function fetchDocBody(url: string): Promise<string | null> {
  const res = await fetch(`${url}.md`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  const txt = await res.text();
  const cleaned = txt.replace(/^(?:>\s*(?:##\s*)?Documentation Index[\s\S]*?\n)(?=\s*#\s)/i, "").trim();
  return cleaned.slice(0, 24_000) || null;
}

// ---------------------------------------------------------------------------
// Attribution — which docs page a post drove to
// ---------------------------------------------------------------------------

export interface DocAttributionResult {
  matched: number;
  unmatched: number;
}

// Deterministic pass: link_resolved_url (and the raw urls array as a fallback)
// against doc_pages.url. Covers 17 of 25 existing posts outright. Human matches
// are never overwritten, same precedence rule as article attribution.
export async function attributeDocPages(): Promise<DocAttributionResult> {
  const posts = await sql<{ id: string; linkUrl: string | null; urls: { expanded_url?: string }[] }>`
    SELECT id, link_resolved_url AS "linkUrl", urls
    FROM posts
    WHERE template = 'dev_doc_post'
      AND is_reply = false
      AND (doc_page_id IS NULL OR doc_page_match <> 'human')`;

  const pages = await sql<{ id: number; url: string }>`SELECT id, url FROM doc_pages`;
  const byUrl = new Map(pages.map((p) => [p.url, p.id]));

  let matched = 0;
  let unmatched = 0;
  for (const post of posts) {
    const candidates = [
      post.linkUrl,
      ...(Array.isArray(post.urls) ? post.urls.map((u) => u?.expanded_url).filter(Boolean) : []),
    ].filter(Boolean) as string[];

    let hit: number | null = null;
    for (const c of candidates) {
      const canon = canonicalDocUrl(c);
      if (canon && byUrl.has(canon)) {
        hit = byUrl.get(canon)!;
        break;
      }
    }
    if (hit != null) {
      await sql`UPDATE posts SET doc_page_id = ${hit}, doc_page_match = 'url', updated_at = now() WHERE id = ${post.id}`;
      matched++;
    } else {
      unmatched++;
    }
  }
  return { matched, unmatched };
}

// ---------------------------------------------------------------------------
// The shelf read
// ---------------------------------------------------------------------------

interface DocShelfSqlRow {
  docPageId: number | null;
  url: string | null;
  path: string | null;
  section: string | null;
  title: string | null;
  blurb: string | null;
  hook: string | null;
  icp: string | null;
  tier: string | null;
  useCount: number;
  lastUsed: string | null;
  daysSinceLastUse: number | null;
  medianImpr: number | null;
  bestImpr: number | null;
}

// Registry-first. Every ACTIVE page appears whether or not it has ever been
// used, plus one residual row for dev-doc posts that resolved to no page at all
// (the CLI photo-posts, mostly) so nothing silently disappears.
export async function getDocShelf(): Promise<DocShelfRow[]> {
  const rows = await sql<DocShelfSqlRow>`
    WITH used AS (
      SELECT p.doc_page_id, p.id, p.created_at, s.impressions
      FROM posts p
      LEFT JOIN LATERAL (
        SELECT impressions FROM metric_snapshots m
        WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
      ) s ON true
      WHERE p.template = 'dev_doc_post' AND p.is_reply = false
    )
    SELECT
      d.id::int                                AS "docPageId",
      d.url, d.path, d.section, d.title, d.blurb, d.hook, d.icp, d.tier,
      COUNT(u.id)::int                         AS "useCount",
      MAX(u.created_at)                        AS "lastUsed",
      EXTRACT(DAY FROM now() - MAX(u.created_at))::int AS "daysSinceLastUse",
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY u.impressions))::int AS "medianImpr",
      MAX(u.impressions)::int                  AS "bestImpr"
    FROM doc_pages d
    LEFT JOIN used u ON u.doc_page_id = d.id
    WHERE d.active = true
    GROUP BY d.id

    UNION ALL

    SELECT
      NULL::bigint, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      COUNT(*)::int,
      MAX(created_at),
      EXTRACT(DAY FROM now() - MAX(created_at))::int,
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY impressions))::int,
      MAX(impressions)::int
    FROM used WHERE doc_page_id IS NULL
    HAVING COUNT(*) > 0
  `;

  const useRows = await sql<DocUse & { docPageId: number | null }>`
    SELECT p.doc_page_id::int AS "docPageId", p.id, p.url, p.created_at AS "createdAt",
           EXTRACT(DAY FROM now() - p.created_at)::int AS "daysAgo",
           p.text, p.media_type AS "mediaType", s.impressions
    FROM posts p
    LEFT JOIN LATERAL (
      SELECT impressions FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
    ) s ON true
    WHERE p.template = 'dev_doc_post' AND p.is_reply = false
    ORDER BY s.impressions DESC NULLS LAST`;

  const usesByPage = new Map<number | null, DocUse[]>();
  for (const u of useRows) {
    const key = u.docPageId == null ? null : Number(u.docPageId);
    const list = usesByPage.get(key) ?? [];
    const { docPageId: _drop, ...use } = u;
    list.push(use);
    usesByPage.set(key, list);
  }

  const maxMedian = Math.max(1, ...rows.map((r) => r.medianImpr ?? 0));
  const icpDays = await getIcpColdness();

  return rows
    .map((r) => {
      const docPageId = r.docPageId == null ? null : Number(r.docPageId);
      const tier = (r.tier as DocTier | null) ?? null;
      return {
        docPageId,
        url: r.url,
        path: r.path,
        section: r.section,
        title: r.title ?? "Docs post with no page link",
        blurb: r.blurb,
        hook: r.hook,
        icp: r.icp,
        icpLabel: r.icp ? (ICP_BY_ID[r.icp]?.label ?? r.icp) : null,
        tier,
        useCount: r.useCount,
        lastUsed: r.lastUsed,
        daysSinceLastUse: r.daysSinceLastUse,
        medianImpr: r.medianImpr,
        bestImpr: r.bestImpr,
        score: docScore(r, maxMedian, icpDays),
        posts: usesByPage.get(docPageId) ?? [],
      };
    })
    .sort((a, b) => b.score - a.score);
}

// "Worth building a post around right now", 0..100.
//
// Deliberately NOT the article shelf's formula. That one ranks re-amplification
// of a proven piece, so performance dominates. Here the opposite is true: 66 of
// 73 pages have no performance history at all, and an untouched Hero page is the
// most valuable thing on the shelf, not the least. So TIER leads, never-used is
// a bonus rather than a blank, and past performance only nudges.
function docScore(
  r: DocShelfSqlRow,
  maxMedian: number,
  icpDays: Map<string, number | null>,
): number {
  const tier = (r.tier as DocTier | null) ?? "supporting";
  if (tier === "reference") return 0; // never recommend a parameter table

  // Untagged pages sit mid-shelf rather than top or bottom — unknown, not bad.
  const tierWeight = tier === "hero" ? 1 : 0.55;

  // Never used is the whole point of this shelf.
  const freshness =
    r.useCount === 0
      ? 1
      : Math.max(0, Math.min(1, ((r.daysSinceLastUse ?? 0) - 14) / 60));

  // Only a nudge, and only when there IS history.
  const perf = r.medianImpr == null ? 0.5 : Math.min(1, r.medianImpr / maxMedian);

  // Each repeat use shaves the ceiling; the homepage habit is what this counters.
  const fatigue = Math.max(0.45, 1 - Math.max(0, r.useCount - 1) * 0.12);

  // Which DOOR has gone coldest. Without this every untouched Hero page scores
  // identically — 28 of them tied at 80 — and the top of the shelf is arbitrary
  // alphabetical noise. The pillar's real rotation is across audiences: five of
  // the eight persona pages have never been posted at all, so "you have never
  // knocked on the AI-agents door" is the most useful thing the ranking can say.
  const cold = r.icp ? icpColdness(icpDays.get(r.icp) ?? null) : 0.5;

  return Math.round(
    Math.max(
      0,
      Math.min(100, tierWeight * (freshness * 0.4 + cold * 0.35 + perf * 0.25) * fatigue * 100),
    ),
  );
}

// Never posted to this ICP = 1. Posted today = 0. Full credit again by ~10 weeks.
function icpColdness(days: number | null): number {
  if (days == null) return 1;
  return Math.max(0, Math.min(1, days / 70));
}

// Days since the last dev-doc post that drove to a page tagged for each ICP.
// Absent from the map = that audience has never been posted to.
async function getIcpColdness(): Promise<Map<string, number | null>> {
  const rows = await sql<{ icp: string; daysSince: number | null }>`
    SELECT d.icp,
           EXTRACT(DAY FROM now() - MAX(p.created_at))::int AS "daysSince"
    FROM posts p
    JOIN doc_pages d ON d.id = p.doc_page_id
    WHERE p.template = 'dev_doc_post' AND p.is_reply = false AND d.icp IS NOT NULL
    GROUP BY d.icp`;
  return new Map(rows.map((r) => [r.icp, r.daysSince]));
}

// Every page on file. Feeds the tagger and the drafter.
export async function listDocPages(opts: { activeOnly?: boolean } = {}): Promise<DocPageRow[]> {
  const activeOnly = opts.activeOnly !== false;
  return sql<DocPageRow>`
    SELECT id, url, path, section, title, blurb, body, icp, tier, hook, active
    FROM doc_pages
    WHERE (${activeOnly} = false OR active = true)
    ORDER BY section, title`;
}

export async function getDocPage(id: number): Promise<DocPageRow | null> {
  const rows = await sql<DocPageRow>`
    SELECT id, url, path, section, title, blurb, body, icp, tier, hook, active
    FROM doc_pages WHERE id = ${id}`;
  return rows[0] ?? null;
}

// The homepage-vs-deep-link gap, computed rather than hardcoded, so the card can
// state the case with this month's numbers instead of the ones in a comment.
export interface HomepagePenalty {
  homeCount: number;
  homeMedian: number | null;
  deepCount: number;
  deepMedian: number | null;
}

export async function getHomepagePenalty(): Promise<HomepagePenalty> {
  const rows = await sql<{ isHome: boolean; n: number; med: number | null }>`
    WITH x AS (
      SELECT (p.link_resolved_url ILIKE '%docs.eco.com/home%') AS "isHome",
             s.impressions
      FROM posts p
      LEFT JOIN LATERAL (
        SELECT impressions FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
      ) s ON true
      WHERE p.template = 'dev_doc_post' AND p.is_reply = false
        AND p.link_resolved_url ILIKE '%docs.eco.com%'
    )
    SELECT "isHome", COUNT(*)::int AS n,
           ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY impressions))::int AS med
    FROM x GROUP BY "isHome"`;
  const home = rows.find((r) => r.isHome);
  const deep = rows.find((r) => !r.isHome);
  return {
    homeCount: home?.n ?? 0,
    homeMedian: home?.med ?? null,
    deepCount: deep?.n ?? 0,
    deepMedian: deep?.med ?? null,
  };
}

export { TIER_ORDER };
