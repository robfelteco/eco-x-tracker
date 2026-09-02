/**
 * Backfill posts.quoted_post_id (Migration 015).
 *
 * Every quote post ingested before that migration has is_quote = true and no
 * quoted_post_id, so the attribution ladder's "quoted" rung cannot fire for it
 * and the pairing between a data-motion visual and the chain article it
 * quote-posted stays invisible to the scorer.
 *
 * Cost: one billed read per post, 100 per call. ~96 posts ≈ $0.48 at
 * X_API_COST_PER_READ_USD. Idempotent — only rows still missing the id are read.
 *
 * Run: node --env-file=.env --experimental-strip-types scripts/backfill-quoted-ids.ts
 * Then re-run attribution:  scripts/backfill-articles.ts
 */
import { sql } from "../lib/db.ts";
import { fetchQuotedRefs, takeReadCount } from "../lib/twitter.ts";

const rows = await sql<{ id: string }>`
  SELECT id FROM posts
  WHERE is_quote = true AND quoted_post_id IS NULL
  ORDER BY created_at DESC
`;
console.log(`${rows.length} quote posts missing quoted_post_id`);
if (!rows.length) process.exit(0);

let filled = 0;
let blank = 0;
for (let i = 0; i < rows.length; i += 100) {
  const batch = rows.slice(i, i + 100).map((r) => r.id);
  const refs = await fetchQuotedRefs(batch);
  for (const r of refs) {
    if (!r.quoted_post_id) {
      // The post is flagged is_quote but X no longer returns the reference —
      // the quoted tweet was deleted, or its author's account went private.
      blank++;
      continue;
    }
    await sql`UPDATE posts SET quoted_post_id = ${r.quoted_post_id}, updated_at = now() WHERE id = ${r.id}`;
    filled++;
  }
  console.log(`  batch ${i / 100 + 1}: ${refs.length} read`);
}
const reads = takeReadCount();
const cost = reads * Number(process.env.X_API_COST_PER_READ_USD || 0.005);
console.log(`\n✅ filled ${filled}, no reference returned ${blank} · ${reads} reads ≈ $${cost.toFixed(2)}`);
