/**
 * Seed the chain-integration articles — the source material the chain pillar
 * was drafting without.
 *
 * Why this is a separate script from ingest-articles.ts: that one reads
 * print-to-PDF blog exports out of two Desktop folders, and no chain piece was
 * ever exported there. The result was that `articles` held 15 rows and not one
 * of them was a chain integration, so lib/generateCopy.ts got no article for a
 * chain target and fell through to "positioning brief + pillar shape". The
 * model then reconstructed plausible Eco copy from nothing — directionally
 * right, factually unsourced, and pointing at an invented eco.com/routes link.
 *
 * Source is the eco.com/blog mirror rather than the X article, for two reasons:
 * it is public (X articles are login-gated) and it is clean prose rather than
 * a two-column PDF interleaved with X sidebar chrome.
 *
 * SHARE_URL is the important column and is NOT the URL we scrape. Pasting an
 * @eco STATUS url into the X composer makes X unfurl the article card, which is
 * the entire point of the draft carrying a link. `x.com/i/article/<id>` does not
 * unfurl. Solana and Polygon predate Eco publishing X articles at all, so they
 * carry the blog url and unfurl as a normal link preview.
 *
 * Run: node --env-file=.env --experimental-strip-types scripts/ingest-chain-articles.ts
 * Requires the firecrawl CLI on PATH and authenticated.
 */
import { execFileSync } from "node:child_process";
import pg from "pg";

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Run with: node --env-file=.env …");
  process.exit(1);
}

// The registry. Adding a chain integration = adding a row here and re-running.
// `shareUrl` null means "no X article exists" and the blog url is used instead.
interface ChainArticle {
  chain: string; // lib/dimensions.ts CHAIN_LABELS id
  slug: string; // eco.com/blog slug
  /** The @eco status post that carried the X article. Null before X articles existed. */
  anchorStatusId: string | null;
  /** x.com/i/article/<id>, recorded for provenance. Never used as the link. */
  xArticleId: string | null;
}

const CHAIN_ARTICLES: ChainArticle[] = [
  {
    chain: "bnb",
    slug: "eco-expands-to-bnb-chain",
    anchorStatusId: "2039679540994171313",
    xArticleId: "2039674298621706241",
  },
  {
    chain: "hyperliquid",
    slug: "eco-upgrades-hyperliquid",
    anchorStatusId: "2038603881513447511",
    xArticleId: "2038601660830765056",
  },
  {
    chain: "tron",
    slug: "eco-integrates-tron",
    anchorStatusId: "2075270264854544548",
    xArticleId: "2075268807166189568",
  },
  {
    chain: "robinhood",
    slug: "eco-integrates-robinhood-chain",
    anchorStatusId: "2082451890869059861",
    xArticleId: "2082239814879854593",
  },
  // Both predate X articles — blog link only.
  { chain: "solana", slug: "eco-powers-stablecoin-bridging-between-solana-in-seconds-not-steps", anchorStatusId: null, xArticleId: null },
  { chain: "polygon", slug: "eco-powers-next-chapter-of-polygons-stablecoin-economy", anchorStatusId: null, xArticleId: null },
];

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function scrape(blogUrl: string): string {
  return execFileSync("firecrawl", ["scrape", blogUrl, "--format", "markdown"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

interface Parsed {
  title: string;
  dek: string | null;
  publishedOn: string | null;
  body: string;
}

/**
 * The Ghost blog template is stable, so walk it rather than regexing blind.
 * Article prose sits between the hero image and the "About Eco" boilerplate;
 * everything outside that is nav, share links, author card and the read-next
 * carousel — all of which would otherwise land in `body` and get handed to the
 * drafter as if it were the piece.
 */
function parse(md: string): Parsed | null {
  const lines = md.split("\n");

  const h1 = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (h1 === -1) return null;
  const title = lines[h1].replace(/^#\s+/, "").trim();

  // The dek is the first prose line under the H1, before the author card.
  let dek: string | null = null;
  for (let i = h1 + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.startsWith("-") || t.startsWith("#") || t.startsWith("!") || t.startsWith("[")) break;
    dek = t;
    break;
  }

  const dm = md.match(/\b(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{4})\s*•/);
  const publishedOn = dm ? `${dm[3]}-${MONTHS[dm[2].toLowerCase()]}-${dm[1].padStart(2, "0")}` : null;

  // Body starts after the hero image (the last image line before the prose) and
  // ends at the "About Eco" divider.
  const aboutIdx = lines.findIndex((l) => /^#{1,3}\s+\*{0,2}About Eco/i.test(l.trim()));
  const heroIdx = lines.findIndex((l, i) => i > h1 && /^!\[/.test(l.trim()));
  const start = heroIdx === -1 ? h1 + 1 : heroIdx + 1;
  const end = aboutIdx === -1 ? lines.length : aboutIdx;

  const body = lines
    .slice(start, end)
    .filter((l) => {
      const t = l.trim();
      if (!t) return true;
      if (/^\*\s*\*\s*\*$/.test(t)) return false; // the --- divider
      if (/^!\[/.test(t)) return false; // images
      if (/^\[Share\]/i.test(t)) return false;
      return true;
    })
    .join("\n")
    // Markdown links -> plain text. The drafter should read "BNB Chain", not a
    // url with a ?ref=eco.com tracking suffix it might then paste into a post.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (body.length < 200) return null;
  return { title, dek, publishedOn, body };
}

const client = new pg.Client({
  connectionString: url,
  ssl: url.includes("localhost") ? false : { rejectUnauthorized: false },
});
await client.connect();

let seeded = 0;
const failures: string[] = [];

for (const ca of CHAIN_ARTICLES) {
  const canonicalUrl = `https://eco.com/blog/${ca.slug}/`;
  let parsed: Parsed | null = null;
  try {
    parsed = parse(scrape(canonicalUrl));
  } catch (err) {
    failures.push(`${ca.chain}: scrape failed — ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  if (!parsed) {
    failures.push(`${ca.chain}: could not parse ${canonicalUrl}`);
    continue;
  }

  // The link the draft must carry. Status url when an X article exists, so the
  // composer unfurls the article card; blog url otherwise.
  const shareUrl = ca.anchorStatusId
    ? `https://x.com/eco/status/${ca.anchorStatusId}`
    : canonicalUrl;
  const xArticleUrl = ca.xArticleId ? `http://x.com/i/article/${ca.xArticleId}` : null;

  await client.query(
    `INSERT INTO articles
       (slug, title, dek, author, published_on, canonical_url, x_article_url, share_url,
        anchor_post_id, kind, chain, body, source_file)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'chain_integration',$10,$11,$12)
     ON CONFLICT (slug) DO UPDATE SET
       title = EXCLUDED.title, dek = EXCLUDED.dek, published_on = EXCLUDED.published_on,
       canonical_url = EXCLUDED.canonical_url, x_article_url = EXCLUDED.x_article_url,
       share_url = EXCLUDED.share_url, anchor_post_id = EXCLUDED.anchor_post_id,
       kind = EXCLUDED.kind, chain = EXCLUDED.chain, body = EXCLUDED.body,
       source_file = EXCLUDED.source_file, updated_at = now()`,
    [
      ca.slug, parsed.title, parsed.dek, "Eco", parsed.publishedOn,
      canonicalUrl, xArticleUrl, shareUrl,
      // Only set when that post is actually in `posts`, or the FK rejects it.
      ca.anchorStatusId, ca.chain, parsed.body, canonicalUrl,
    ],
  );
  seeded++;
  console.log(`  ✓ [${ca.chain}] ${parsed.title}`);
  console.log(`      ${parsed.publishedOn ?? "no date"} · ${parsed.body.length} chars · link ${shareUrl}`);
}

// Backfill article_id on the posts that already used these pieces, so the
// "angles already spent" block in lib/generateCopy.ts has something to read.
const linked = await client.query(
  `UPDATE posts p SET article_id = a.id, article_match = 'chain', article_confidence = 1.0
   FROM articles a
   WHERE a.chain IS NOT NULL
     AND a.chain = ANY(p.chains)
     AND p.template = 'integration_announcement'
     AND p.is_reply = false
     AND (p.article_id IS NULL OR p.article_match <> 'human')`,
);
console.log(`\nSeeded ${seeded} chain articles. Linked ${linked.rowCount} prior posts.`);
if (failures.length) console.log(`Failures:\n  ${failures.join("\n  ")}`);
await client.end();
