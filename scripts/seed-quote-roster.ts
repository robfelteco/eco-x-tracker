/**
 * Seed the quote-discovery roster (Migration 007). Spec §12 step 1: hand-seed
 * the people table BEFORE any fetch code runs — the pipeline is only as good as
 * this table.
 *
 *   node --env-file=.env scripts/seed-quote-roster.ts
 *
 * Idempotent. Existing rows are left alone, so operator edits survive a re-run.
 *
 * IMPORTANT: seeded titles are unverified. `handles_verified_at` stays null and
 * the review card badges them as such — confirm before a card ships.
 */
import pg from "pg";
import { ORG_SEED, PEOPLE_SEED, WATCH_SEED } from "../lib/quoteRoster.ts";

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Run with: node --env-file=.env scripts/seed-quote-roster.ts");
  process.exit(1);
}
const client = new pg.Client({
  connectionString: url,
  ssl: url.includes("localhost") ? false : { rejectUnauthorized: false },
});
await client.connect();

let orgs = 0;
for (const o of ORG_SEED) {
  const r = await client.query(
    `INSERT INTO orgs (name, org_tier, x_handle, is_competitor)
     VALUES ($1,$2,$3,$4) ON CONFLICT (name) DO NOTHING RETURNING id`,
    [o.name, o.tier, o.xHandle ?? null, o.isCompetitor ?? false],
  );
  if (r.rowCount) orgs++;
}

let people = 0;
const missingOrg: string[] = [];
for (const p of PEOPLE_SEED) {
  const org = await client.query<{ id: string }>(`SELECT id FROM orgs WHERE name = $1`, [p.org]);
  if (!org.rowCount) {
    missingOrg.push(`${p.name} → ${p.org}`);
    continue;
  }
  // The uniqueness index on x_handle is PARTIAL (handle may be null), which
  // ON CONFLICT can't infer, and people without a handle need name-based
  // dedupe anyway. So check first, then insert.
  const existing = await client.query(
    `SELECT id FROM people WHERE ($1::text IS NOT NULL AND lower(x_handle) = lower($1)) OR full_name = $2`,
    [p.xHandle ?? null, p.name],
  );
  if (existing.rowCount) continue;
  await client.query(
    `INSERT INTO people (full_name, title, org_id, seniority, x_handle) VALUES ($1,$2,$3,$4,$5)`,
    [p.name, p.title, org.rows[0].id, p.seniority, p.xHandle ?? null],
  );
  people++;
}

let watches = 0;
for (const w of WATCH_SEED) {
  const r = await client.query(
    `INSERT INTO watch_sources (kind, identifier, label)
     VALUES ($1,$2,$3) ON CONFLICT (kind, identifier) DO NOTHING RETURNING id`,
    [w.kind, w.identifier, w.label],
  );
  if (r.rowCount) watches++;
}

const totals = await client.query<{ people: string; orgs: string; withx: string; watch: string }>(
  `SELECT (SELECT COUNT(*) FROM people WHERE active) AS people,
          (SELECT COUNT(*) FROM orgs) AS orgs,
          (SELECT COUNT(*) FROM people WHERE active AND x_handle IS NOT NULL) AS withx,
          (SELECT COUNT(*) FROM watch_sources WHERE active) AS watch`,
);
const t = totals.rows[0];
console.log(`Inserted ${orgs} orgs, ${people} people, ${watches} watch sources.`);
console.log(`Roster now: ${t.people} people (${t.withx} with an X handle) across ${t.orgs} orgs · ${t.watch} watch sources.`);
if (missingOrg.length) console.log(`\nSkipped (org not in ORG_SEED):\n  ${missingOrg.join("\n  ")}`);
console.log(`\nEvery seeded title is UNVERIFIED (handles_verified_at is null). Confirm before a card ships.`);
await client.end();
