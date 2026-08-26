// Seed / refresh the docs shelf from docs.eco.com/llms.txt, attribute existing
// dev-doc posts to their page, then tag anything untagged.
//
// Run: npx tsx --env-file=.env scripts/sync-docs.ts [--force-tags] [--no-tags]
import { syncDocPages, attributeDocPages, getHomepagePenalty } from "../lib/docs.ts";
import { tagDocPages } from "../lib/docsTag.ts";

const force = process.argv.includes("--force-tags");
const noTags = process.argv.includes("--no-tags");

const sync = await syncDocPages();
console.log(
  `docs: ${sync.fetched} in llms.txt · ${sync.inserted} new · ${sync.updated} updated · ` +
    `${sync.deactivated} deactivated · ${sync.bodiesFetched} bodies fetched`,
);
if (sync.errors.length) console.log(`  body errors: ${sync.errors.slice(0, 5).join("; ")}`);

const attr = await attributeDocPages();
console.log(`attribution: ${attr.matched} posts matched to a page · ${attr.unmatched} unmatched`);

if (!noTags) {
  const tags = await tagDocPages({ force });
  console.log(
    `tagging: ${tags.tagged} tagged · ${tags.skipped} skipped · ` +
      Object.entries(tags.byTier).map(([t, n]) => `${n} ${t}`).join(", "),
  );
  if (tags.errors.length) console.log(`  errors: ${tags.errors.join("; ")}`);
}

const pen = await getHomepagePenalty();
console.log(
  `homepage penalty: /home ${pen.homeCount} posts @ ${pen.homeMedian} median · ` +
    `deep links ${pen.deepCount} posts @ ${pen.deepMedian} median`,
);
