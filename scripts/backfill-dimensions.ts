/**
 * One-shot backfill for chain/entity sub-dimensions on existing rows (Migration
 * 004). Fresh ingests populate posts.chains / posts.entities inline now (see
 * lib/ingest.ts); this recomputes them for history using the SAME extractor so
 * there's a single source of truth (lib/dimensions.ts).
 *
 * Run migrate first, then: node --env-file=.env scripts/backfill-dimensions.ts
 * (Node ≥23.6 strips the TS types natively; no build step.)
 */
import pg from "pg";
import { extractDimensions } from "../lib/dimensions.ts";

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Run with: node --env-file=.env scripts/backfill-dimensions.ts");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  ssl: url.includes("localhost") ? false : { rejectUnauthorized: false },
});
await client.connect();

const { rows } = await client.query<{
  id: string;
  text: string;
  mentions: string[];
  domains: string[];
  media_type: string;
  link_title: string | null;
}>(`SELECT id, text, mentions, domains, media_type, link_title FROM posts`);

console.log(`Scanning ${rows.length} posts…`);

let changed = 0;
let withChain = 0;
let withEntity = 0;
let withProduct = 0;
const chainTally: Record<string, number> = {};
const entityTally: Record<string, number> = {};
const productTally: Record<string, number> = {};
const shapeTally: Record<string, number> = {};

for (const r of rows) {
  const dim = extractDimensions({
    text: r.text,
    mentions: r.mentions || [],
    domains: r.domains || [],
    mediaType: r.media_type,
    linkTitle: r.link_title,
  });
  if (dim.chains.length) withChain++;
  if (dim.entities.length) withEntity++;
  if (dim.products.length) withProduct++;
  for (const c of dim.chains) chainTally[c] = (chainTally[c] ?? 0) + 1;
  for (const e of dim.entities) entityTally[e] = (entityTally[e] ?? 0) + 1;
  for (const pr of dim.products) productTally[pr] = (productTally[pr] ?? 0) + 1;
  shapeTally[dim.shape] = (shapeTally[dim.shape] ?? 0) + 1;
  await client.query(
    `UPDATE posts SET chains = $1, entities = $2, products = $3, shape = $4, updated_at = now() WHERE id = $5`,
    [dim.chains, dim.entities, dim.products, dim.shape, r.id],
  );
  changed++;
}

const top = (t: Record<string, number>) =>
  Object.entries(t)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}:${n}`)
    .join("  ");

console.log(`\nUpdated ${changed} rows.`);
console.log(`  ${withChain} have ≥1 chain · ${withEntity} have ≥1 entity · ${withProduct} have ≥1 product`);
console.log(`  chains → ${top(chainTally) || "none"}`);
console.log(`  entities → ${top(entityTally) || "none"}`);
console.log(`  products → ${top(productTally) || "none"}`);
console.log(`  shapes   → ${top(shapeTally) || "none"}`);

await client.end();
