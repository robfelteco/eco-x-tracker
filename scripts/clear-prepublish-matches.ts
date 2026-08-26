/**
 * Clear content-match attributions that are impossible on their dates.
 *
 *   node --env-file=.env scripts/clear-prepublish-matches.ts [--dry-run]
 *
 * The Claude rung of the attribution ladder hedges at ~0.78 when it is really
 * pattern-matching on shared Eco vocabulary, which clears CLAUDE_MATCH_THRESHOLD
 * (0.75). That welded four generic posts onto articles published 37-64 days
 * AFTER them — most visibly a May 15th thought_leadership post onto the Verified
 * Liquidity PRODUCT piece, which then showed on the Thought Leadership shelf as
 * "last posted 103 days ago" while Product correctly read 11 days.
 *
 * lib/articleAttribution.ts now refuses these at match time, so this only has to
 * clean up what was written before that guard existed. Rows go back to NULL, not
 * to some "rejected" state: unattributed is the honest answer, the shelf shows
 * them in its residual group, and a later re-run is free to place them on a
 * deterministic rung. Human-set attributions are never touched.
 */
import pg from "pg";

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Run with: node --env-file=.env scripts/clear-prepublish-matches.ts");
  process.exit(1);
}
const dryRun = process.argv.includes("--dry-run");

const client = new pg.Client({
  connectionString: url,
  ssl: url.includes("localhost") ? false : { rejectUnauthorized: false },
});
await client.connect();

const { rows: doomed } = await client.query<{
  id: string;
  template: string;
  posted: string;
  title: string;
  kind: string;
  pub: string;
  confidence: string;
  days_early: string;
}>(`
  SELECT p.id, p.template::text AS template,
         to_char(p.created_at, 'YYYY-MM-DD') AS posted,
         a.title, a.kind, to_char(a.published_on, 'YYYY-MM-DD') AS pub,
         p.article_confidence::text AS confidence,
         (a.published_on::date - p.created_at::date)::text AS days_early
    FROM posts p
    JOIN articles a ON a.id = p.article_id
   WHERE p.is_reply = false
     AND p.article_match = 'claude'
     AND a.published_on IS NOT NULL
     AND p.created_at::date < a.published_on::date
   ORDER BY (a.published_on::date - p.created_at::date) DESC
`);

if (!doomed.length) {
  console.log("No pre-publication content matches on file. Nothing to clear.");
} else {
  console.log(`${doomed.length} pre-publication content match(es):\n`);
  for (const d of doomed) {
    console.log(`  ${d.id}  ${d.posted}  ${d.template}`);
    console.log(`    -> [${d.kind}] ${d.title} (published ${d.pub}, ${d.days_early}d later, conf ${d.confidence})`);
  }
  if (dryRun) {
    console.log("\n--dry-run: nothing written.");
  } else {
    const { rowCount } = await client.query(
      `UPDATE posts
          SET article_id = NULL, article_match = NULL, article_confidence = NULL, updated_at = now()
        WHERE id = ANY($1::text[]) AND article_match IS DISTINCT FROM 'human'`,
      [doomed.map((d) => d.id)],
    );
    console.log(`\nCleared ${rowCount} post(s) back to unattributed.`);
  }
}

await client.end();
