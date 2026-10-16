/**
 * Run the Broad Educational intake by hand (lib/eduIntake.ts).
 *
 *   node --env-file=.env scripts/edu-intake.ts                 # Grok lenses + analog shelf
 *   node --env-file=.env scripts/edu-intake.ts --no-grok       # analog shelf only (cheap)
 *   node --env-file=.env scripts/edu-intake.ts --per-lens 2 --analog 4 --scrapes 8
 *   node --env-file=.env scripts/edu-intake.ts --attribute     # only the sync-time URL match
 *
 * Costs: 1 Firecrawl credit per scrape, three xAI calls for the lenses, and
 * one Claude call per new candidate. A default run is ~15 candidates.
 */
import { runEduIntake, attributeEduCandidates } from "../lib/eduIntake.ts";

const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i > -1 ? process.argv[i + 1] : undefined;
};

if (process.argv.includes("--attribute")) {
  const r = await attributeEduCandidates();
  console.log(`matched ${r.matched} candidate(s) to posts by URL`);
  process.exit(0);
}

const started = Date.now();
const r = await runEduIntake({
  trigger: "manual",
  deadline: Date.now() + 9 * 60_000,
  skipGrok: process.argv.includes("--no-grok"),
  perLens: Number(arg("--per-lens") ?? 4),
  analogSources: Number(arg("--analog") ?? 6),
  maxScrapes: Number(arg("--scrapes") ?? 15),
});
console.log(
  `run #${r.runId}: scanned ${r.scanned} · added ${r.added} · deduped ${r.deduped} · scrape failed ${r.scrapeFailed} · ` +
    `${r.credits} credits · ${Math.round((Date.now() - started) / 1000)}s${r.partial ? " · PARTIAL" : ""}`,
);
for (const h of r.added_headlines) console.log(`  + ${h}`);
for (const w of r.warnings) console.log(`  ! ${w.slice(0, 160)}`);
