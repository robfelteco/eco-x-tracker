/**
 * Run the analog-source sweep by hand.
 *
 *   node --env-file=.env scripts/sweep-analogs.ts              # 4 concepts, oldest first
 *   node --env-file=.env scripts/sweep-analogs.ts --n 2
 *   node --env-file=.env scripts/sweep-analogs.ts --id nostro_vostro
 *   node --env-file=.env scripts/sweep-analogs.ts --all        # every concept (expensive)
 *
 * Costs roughly 9-13 Firecrawl credits per concept plus one Claude extraction
 * call. `--all` is about 200 credits, so it is opt-in rather than the default.
 */
import { sweepConcept, runAnalogSweep, pickConceptsToSweep } from "../lib/analogSweep.ts";
import { ANALOG_DEFS } from "../lib/analogs.ts";

const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const id = arg("--id");
const n = Number(arg("--n") ?? 4);
const all = process.argv.includes("--all");

function report(r: Awaited<ReturnType<typeof sweepConcept>>) {
  console.log(
    `  ${r.label.padEnd(34)} +${r.added} kept · ${r.rejected} rejected · ${r.scanned} scanned · ${r.credits} credits${r.partial ? " · PARTIAL" : ""}`,
  );
  for (const w of r.warnings.slice(0, 3)) console.log(`      ${w.slice(0, 130)}`);
}

if (id) {
  report(await sweepConcept(id, { maxScrapes: 4 }));
} else if (all) {
  console.log(`Sweeping all ${ANALOG_DEFS.length} concepts. This is the expensive path.\n`);
  for (const d of ANALOG_DEFS) report(await sweepConcept(d.id, { maxScrapes: 4 }));
} else {
  console.log(`Next up (oldest swept first): ${(await pickConceptsToSweep(n)).join(", ")}\n`);
  const r = await runAnalogSweep({ concepts: n, maxScrapes: 4 });
  r.results.forEach(report);
  console.log(`\nTotal: +${r.totalAdded} sources, ${r.totalCredits} Firecrawl credits.`);
  for (const w of r.warnings) console.log(`  ! ${w.slice(0, 160)}`);
}
