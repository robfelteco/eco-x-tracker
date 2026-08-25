/**
 * One-shot backfill: tie every existing post to the article it amplifies
 * (Migration 006). Run AFTER scripts/ingest-articles.ts has seeded the registry.
 *
 *   node --env-file=.env scripts/backfill-articles.ts [--no-claude]
 *
 * Deterministic rungs (url / xurl / anchor) are free. The Claude rung costs a
 * few cents and only fires for posts nothing else could place — pass
 * --no-claude to skip it and see how far the free rungs get on their own.
 */
import pg from "pg";
import { attributeArticles, type SqlTag } from "../lib/articleAttribution.ts";
import { makeClaudeMatcher } from "../lib/articleMatchClaude.ts";

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Run with: node --env-file=.env scripts/backfill-articles.ts");
  process.exit(1);
}
const useClaude = !process.argv.includes("--no-claude");

const client = new pg.Client({
  connectionString: url,
  ssl: url.includes("localhost") ? false : { rejectUnauthorized: false },
});
await client.connect();

// Tagged-template shim so the shared attribution module can run over `pg`
// exactly as it does over the Neon HTTP driver in the app.
const sql: SqlTag = async <T>(strings: TemplateStringsArray, ...params: unknown[]) => {
  const text = strings.reduce((acc, s, i) => acc + s + (i < params.length ? `$${i + 1}` : ""), "");
  const res = await client.query(text, params as unknown[]);
  return res.rows as T[];
};

const cost = { usd: 0 };
const res = await attributeArticles(sql, {
  claudeMatch: useClaude ? makeClaudeMatcher(cost) : undefined,
});

console.log(`Scanned ${res.scanned} posts in article-bearing pillars.`);
console.log(`  matched: ${Object.entries(res.matched).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
console.log(`  anchors resolved: ${res.anchorsResolved}`);
console.log(`  claude groups: ${res.claudeGroups} (cost $${cost.usd.toFixed(4)})`);
console.log(`  still unattributed: ${res.unmatched}`);
if (res.errors.length) console.log(`  errors:\n    ${res.errors.join("\n    ")}`);

const { rows } = await client.query<{ title: string; uses: string; kind: string }>(
  `SELECT a.title, a.kind, COUNT(p.id)::text AS uses
     FROM articles a LEFT JOIN posts p ON p.article_id = a.id
    GROUP BY a.id, a.title, a.kind ORDER BY COUNT(p.id) DESC, a.title`,
);
console.log(`\nShelf:`);
for (const r of rows) console.log(`  ${String(r.uses).padStart(2)}×  [${r.kind}] ${r.title}`);
await client.end();
