// One-shot cleanup: we now track only MAIN posts. Delete any reply rows that were
// ingested under the old policy (self-replies/thread continuations + replies to
// others). metric_snapshots and labels cascade via ON DELETE CASCADE.
//
// Run: node --env-file=.env scripts/cleanup-replies.mjs
import pg from "pg";

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Run: node --env-file=.env scripts/cleanup-replies.mjs");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  ssl: url.includes("localhost") ? false : { rejectUnauthorized: false },
});

try {
  await client.connect();
  const before = await client.query("SELECT COUNT(*)::int AS n FROM posts WHERE is_reply = true");
  const n = before.rows[0].n;
  if (n === 0) {
    console.log("✅ no reply rows to remove");
  } else {
    await client.query("DELETE FROM posts WHERE is_reply = true");
    console.log(`✅ deleted ${n} reply row(s) (snapshots + labels cascaded)`);
  }
} catch (err) {
  console.error("❌ cleanup failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
