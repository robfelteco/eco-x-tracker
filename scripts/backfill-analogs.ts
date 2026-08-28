/**
 * One-shot backfill for posts.analog_id (Migration 009). Fresh ingests tag
 * inline now (lib/ingest.ts); this recomputes history with the SAME extractor
 * so there is one source of truth (lib/analogs.ts).
 *
 * Expect a LOW hit rate — that is the finding, not a bug. Broad Educational is
 * 71 posts of market news and none of it teaches a mechanism, so a near-empty
 * curriculum board on day one is the honest starting state.
 *
 * Run migrate first, then: node --env-file=.env scripts/backfill-analogs.ts
 * (Node >= 23.6 strips the TS types natively; no build step.)
 */
import pg from "pg";
import { detectAnalog, ANALOG_BY_ID } from "../lib/analogs.ts";

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Run with: node --env-file=.env scripts/backfill-analogs.ts");
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
  template: string;
  link_title: string | null;
  link_description: string | null;
}>(`SELECT id, text, template, link_title, link_description FROM posts WHERE is_reply = false`);

console.log(`Scanning ${rows.length} main posts…`);

let tagged = 0;
const tally: Record<string, number> = {};
const byTemplate: Record<string, number> = {};

for (const r of rows) {
  const analogId = detectAnalog([r.text, r.link_title, r.link_description].filter(Boolean).join(" \n "));
  if (analogId) {
    tagged++;
    tally[analogId] = (tally[analogId] ?? 0) + 1;
    byTemplate[r.template] = (byTemplate[r.template] ?? 0) + 1;
  }
  await client.query(`UPDATE posts SET analog_id = $1, updated_at = now() WHERE id = $2`, [analogId, r.id]);
}

const top = (t: Record<string, number>) =>
  Object.entries(t)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${ANALOG_BY_ID[k]?.label ?? k}:${n}`)
    .join("  ") || "none";

console.log(`\nTagged ${tagged} of ${rows.length} posts with an analog concept.`);
console.log(`  concepts → ${top(tally)}`);
console.log(
  `  by pillar → ${
    Object.entries(byTemplate)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}:${n}`)
      .join("  ") || "none"
  }`,
);
console.log(`\n${Object.keys(tally).length} of 20 concepts have ever been touched.`);

await client.end();
