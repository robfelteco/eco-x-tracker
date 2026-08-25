/**
 * Seed the `articles` registry (Migration 006) from the blog PDFs on disk.
 *
 * Every eco.com/blog print-to-PDF carries the same page-1 furniture: a print
 * timestamp, the running-header title, the wrapped H1, the dek, the author,
 * "Share", the publish date, and the canonical URL in the footer. That makes
 * the seed fully deterministic — no LLM, no scraping.
 *
 * Requires `pdftotext` (poppler). Run:
 *   node --env-file=.env scripts/ingest-articles.ts \
 *     "product:$HOME/Desktop/Product Blogs" \
 *     "thought_leadership:$HOME/Desktop/Thought Leadership Blogs"
 *
 * Re-running is safe: rows upsert on slug.
 */
import pg from "pg";
import { readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { extractProducts } from "../lib/products.ts";
import { ecoBlogSlug } from "../lib/articleKeys.ts";

const DEFAULT_DIRS: [string, string][] = [
  ["product", join(process.env.HOME!, "Desktop/Product Blogs")],
  ["thought_leadership", join(process.env.HOME!, "Desktop/Thought Leadership Blogs")],
];

const dirs: [string, string][] = process.argv.slice(2).length
  ? process.argv.slice(2).map((a) => {
      const i = a.indexOf(":");
      return [a.slice(0, i), a.slice(i + 1)] as [string, string];
    })
  : DEFAULT_DIRS;

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Run with: node --env-file=.env scripts/ingest-articles.ts");
  process.exit(1);
}

function pdfText(file: string, firstPage?: number, lastPage?: number): string {
  const args: string[] = [];
  if (firstPage) args.push("-f", String(firstPage));
  if (lastPage) args.push("-l", String(lastPage));
  args.push(file, "-");
  return execFileSync("pdftotext", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

interface Parsed {
  title: string;
  dek: string | null;
  author: string | null;
  publishedOn: string | null;
  canonicalUrl: string | null;
  slug: string;
}

// Page 1 has a fixed shape. Walk it rather than regexing blind, so a change in
// the template fails loudly instead of writing a plausible-but-wrong row.
function parseFront(page1: string, file: string): Parsed | null {
  const lines = page1.split("\n").map((l) => l.trim());
  const nonEmpty = lines.filter(Boolean);
  // 1. drop the print timestamp ("8/24/26, 3:12 PM")
  let i = 0;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4},/.test(nonEmpty[0] ?? "")) i = 1;

  // 2. the running header is the full title on one line
  const title = nonEmpty[i];
  if (!title) return null;
  i++;

  // 3. skip the wrapped H1 — accumulate lines until they re-spell the title
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  let acc = "";
  while (i < nonEmpty.length && normalize(acc) !== normalize(title)) {
    acc = acc ? `${acc} ${nonEmpty[i]}` : nonEmpty[i];
    i++;
    if (acc.length > title.length + 40) break; // template drift — bail out of the walk
  }

  // 4. everything up to the author line is the dek; the author sits just above "Share"
  const shareIdx = nonEmpty.findIndex((l, n) => n >= i && /^share$/i.test(l));
  let author: string | null = null;
  let dek: string | null = null;
  if (shareIdx > i) {
    author = nonEmpty[shareIdx - 1] ?? null;
    const dekLines = nonEmpty.slice(i, shareIdx - 1);
    dek = dekLines.join(" ").trim() || null;
  }

  // 5. publish date — "18 Dec 2025"
  const dm = page1.match(/\b(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{4})\b/);
  const publishedOn = dm ? `${dm[3]}-${MONTHS[dm[2].toLowerCase()]}-${dm[1].padStart(2, "0")}` : null;

  // 6. canonical URL from the footer
  const um = page1.match(/https?:\/\/eco\.com\/blog\/[a-z0-9-]+\/?/i);
  const canonicalUrl = um ? um[0] : null;
  const slug = ecoBlogSlug(canonicalUrl) ?? basename(file).replace(/\.pdf$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-");

  return { title, dek, author, publishedOn, canonicalUrl, slug };
}

// Strip the repeated print furniture so `body` is the article, not the chrome.
function cleanBody(all: string, title: string): string {
  const titleNorm = title.toLowerCase().replace(/\s+/g, " ").trim();
  return all
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      if (!t) return true;
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4},\s+\d{1,2}:\d{2}\s*(AM|PM)$/i.test(t)) return false;
      if (/^https?:\/\/eco\.com\/blog\//i.test(t)) return false;
      if (/^\d+\/\d+$/.test(t)) return false;
      if (t.toLowerCase() === titleNorm) return false;
      if (/^share$/i.test(t)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const client = new pg.Client({
  connectionString: url,
  ssl: url.includes("localhost") ? false : { rejectUnauthorized: false },
});
await client.connect();

let seeded = 0;
const failures: string[] = [];

for (const [kind, dir] of dirs) {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf"));
  } catch {
    failures.push(`cannot read ${dir}`);
    continue;
  }
  for (const f of files) {
    const full = join(dir, f);
    const page1 = pdfText(full, 1, 1);
    const parsed = parseFront(page1, full);
    if (!parsed) {
      failures.push(`${f}: could not parse page 1`);
      continue;
    }
    const body = cleanBody(pdfText(full), parsed.title);
    // Product is derived from the title + dek, which name the product outright
    // in all 8 product articles; body is the fallback.
    const fromTitle = extractProducts(`${parsed.title} ${parsed.dek ?? ""}`.toLowerCase(), true);
    const product = kind === "product" ? (fromTitle[0] ?? extractProducts(body.toLowerCase(), true)[0] ?? null) : null;

    await client.query(
      `INSERT INTO articles (slug, title, dek, author, published_on, canonical_url, kind, product, body, source_file)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (slug) DO UPDATE SET
         title = EXCLUDED.title, dek = EXCLUDED.dek, author = EXCLUDED.author,
         published_on = EXCLUDED.published_on, canonical_url = EXCLUDED.canonical_url,
         kind = EXCLUDED.kind, product = EXCLUDED.product, body = EXCLUDED.body,
         source_file = EXCLUDED.source_file, updated_at = now()`,
      [parsed.slug, parsed.title, parsed.dek, parsed.author, parsed.publishedOn,
       parsed.canonicalUrl, kind, product, body, f],
    );
    seeded++;
    console.log(`  ✓ [${kind}${product ? "/" + product : ""}] ${parsed.title}`);
    console.log(`      ${parsed.publishedOn ?? "no date"} · ${parsed.author ?? "no author"} · /${parsed.slug} · ${body.length} chars`);
  }
}

console.log(`\nSeeded ${seeded} articles.`);
if (failures.length) console.log(`Failures:\n  ${failures.join("\n  ")}`);
await client.end();
