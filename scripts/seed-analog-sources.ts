/**
 * Seed analog_sources from the hand-curated AnalogDef.sources, then optionally
 * fill the gaps by search.
 *
 *   node --env-file=.env scripts/seed-analog-sources.ts          # seeds only
 *   node --env-file=.env scripts/seed-analog-sources.ts --fill   # + find sources
 *                                                                #   for concepts
 *                                                                #   with none
 * The --fill pass spends xAI credits and verifies every URL over HTTP, so it is
 * opt-in and runs concepts one at a time rather than fanning out.
 */
import { seedRegistrySources, findSourcesFor, getSourcesFor } from "../lib/analogSources.ts";
import { ANALOG_DEFS } from "../lib/analogs.ts";

const { inserted, skipped } = await seedRegistrySources();
console.log(`Seeded ${inserted} hand-curated sources (${skipped} skipped — URL did not resolve).`);

if (process.argv.includes("--fill")) {
  const empty: string[] = [];
  for (const d of ANALOG_DEFS) {
    if ((await getSourcesFor(d.id)).length === 0) empty.push(d.id);
  }
  console.log(`\n${empty.length} concepts have no source material. Searching…\n`);
  for (const id of empty) {
    try {
      const r = await findSourcesFor(id);
      console.log(`  ${id.padEnd(26)} +${r.added} kept, ${r.rejected.length} rejected`);
      for (const s of r.sources.slice(0, 3)) console.log(`      · ${s.publisher ?? "?"} — ${s.title.slice(0, 70)}`);
      for (const x of r.rejected) console.log(`      ✗ ${x.status ?? "unreachable"} ${x.url.slice(0, 70)}`);
    } catch (e) {
      console.log(`  ${id.padEnd(26)} FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

const totals = await Promise.all(ANALOG_DEFS.map(async (d) => (await getSourcesFor(d.id)).length));
const withSrc = totals.filter((n) => n > 0).length;
console.log(`\n${withSrc}/${ANALOG_DEFS.length} concepts now have verified source material.`);
