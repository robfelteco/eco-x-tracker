// One-shot schema migration. Applies db/schema.sql (idempotent) to the database
// in DATABASE_URL. Run: `node --env-file=.env scripts/migrate.mjs`
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Prefer the UNPOOLED (direct) endpoint for migrations — DDL and multi-statement
// runs behave better on a direct session than through the pgbouncer pooler.
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Run with: node --env-file=.env scripts/migrate.mjs");
  process.exit(1);
}

const schema = readFileSync(join(__dirname, "..", "db", "schema.sql"), "utf8");

const client = new pg.Client({
  connectionString: url,
  ssl: url.includes("localhost") ? false : { rejectUnauthorized: false },
});

try {
  await client.connect();
  await client.query(schema); // whole file in one simple-protocol call
  console.log("✅ schema applied");
} catch (err) {
  console.error("❌ migration failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
