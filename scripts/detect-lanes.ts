/**
 * Run the lane detector by hand — the same pass lib/ingest.ts runs at the end
 * of every sync (Migration 019). Useful for the first run over history, and for
 * re-checking after the registry has been edited.
 *
 * Run: node --env-file=.env scripts/detect-lanes.ts
 */
import { neon } from "@neondatabase/serverless";
import { detectLanes } from "../lib/laneDetect.ts";
import { getLaneRegistry } from "../lib/laneRegistry.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Run with: node --env-file=.env scripts/detect-lanes.ts");
  process.exit(1);
}
const sql = neon(url) as never;

const r = await detectLanes(sql);
console.log(`\nScanned ${r.scanned} untagged posts · ${r.called} Claude calls`);
for (const l of r.created) {
  console.log(`  + NEW ${l.kind}/${l.id} — ${l.label}`);
  console.log(`        handles: ${l.handles.join(", ") || "—"} · terms: ${l.terms.join(", ") || "—"}`);
  console.log(`        ${l.why}`);
}
for (const l of r.widened) console.log(`  ~ widened ${l.kind}/${l.id} with @${l.handles.join(", @")}`);
console.log(`  ${r.retagged} posts re-tagged`);
if (r.errors.length) console.log(`\nErrors:\n  ${r.errors.join("\n  ")}`);

const reg = await getLaneRegistry(sql);
console.log(`\nRegistry now: ${reg.byKind.chain.length} chains · ${reg.byKind.product.length} products · ${reg.byKind.partner.length} partners · ${reg.pending.length} awaiting review`);
