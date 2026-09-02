// Export everything that feeds the in-tool copy drafter as a single markdown
// document, for use outside the app (a Claude Project, a new teammate, a
// contractor writing a batch of posts by hand).
//
// It GENERATES rather than transcribes, on purpose. A hand-written copy of this
// material is a fourth place for the positioning to go stale, and this repo has
// already paid that bill once: three prompt files were still describing Eco by
// the superseded June-8 category a week after lib/positioning.ts moved off it.
// Everything below is read out of the live modules, so re-running the script is
// the only maintenance the document needs.
//
//   npx tsx scripts/export-copy-brief.ts        -> writes COPY-BRIEF.md
//   npx tsx scripts/export-copy-brief.ts <path> -> writes somewhere else
//
// What it deliberately cannot include: the per-draft material the app pulls out
// of Postgres at request time (article bodies, docs pages, video transcripts,
// retrieved source passages, and the angles already spent on a source). Those
// are different on every call. The document names them and says what to paste
// in instead, which is the whole difference between this and the real tool.

import { writeFileSync } from "fs";
import { ECO_ONE_LINER, POSITIONING_BRIEF } from "../lib/positioning.ts";
import { TEMPLATE_DEFS } from "../lib/taxonomy.ts";
import { PILLAR_SHAPES } from "../lib/pillarShapes.ts";
import { ANTI_SLOP_BRIEF, formBlock, LENGTH_BANDS } from "../lib/antiSlop.ts";
import { ICP_DEFS } from "../lib/icp.ts";
import { PRODUCT_DEFS, PRODUCT_POST_SHAPES } from "../lib/products.ts";
import {
  ANALOG_DEFS,
  EDUCATION_SHAPES,
  TIER_LABEL as ANALOG_TIER_LABEL,
  TIER_HINT as ANALOG_TIER_HINT,
  type AnalogTier,
} from "../lib/analogs.ts";
import { BAND_CONTRACT, SCORING_RUBRIC } from "../lib/draftContract.ts";

const out: string[] = [];
const w = (s = "") => out.push(s);
const fence = (body: string, lang = "") => {
  w("```" + lang);
  w(body);
  w("```");
  w();
};

const today = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- front matter
w("# Eco copy brief");
w();
w(`Everything that feeds the copy drafter in the Eco X tracker, in one document.`);
w();
w(
  `Generated from the live source on ${today} by \`scripts/export-copy-brief.ts\`. ` +
    `Do not hand-edit: change the module and re-run the script, or the edit is lost ` +
    `and the app and this document disagree.`,
);
w();
w("| Section | Generated from |");
w("| --- | --- |");
w("| Who Eco is, voice, guardrails | `lib/positioning.ts` |");
w("| Form and length | `lib/antiSlop.ts` |");
w("| The nine content pillars | `lib/taxonomy.ts` + `lib/pillarShapes.ts` |");
w("| Who you are writing for | `lib/icp.ts` |");
w("| Products and their guardrails | `lib/products.ts` |");
w("| The tradfi analog curriculum | `lib/analogs.ts` |");
w("| Anti-slop standard | `lib/antiSlop.ts` (full version in `ANTI-SLOP.md`) |");
w("| Output contract and scoring | `lib/draftContract.ts` |");
w();

// ---------------------------------------------------------------- how to use
w("## How to use this");
w();
w(
  "The app assembles a prompt per draft: this document is the static half of it, " +
    "and the half that never changes between calls. Handed to a chat assistant it " +
    "gets you most of the way to what the tool produces.",
);
w();
w("**The one-line version of Eco**, which every other prompt in the app imports:");
w();
fence(ECO_ONE_LINER);
w("**What this document cannot give you.** The app also injects, per draft:");
w();
w("- the **source article** body, so the draft argues from the piece rather than about it");
w("- the **docs page** body, when the post drives to docs");
w("- the **video transcript**, so short-form copy quotes the line the clip turns on");
w("- **retrieved source passages** for a curriculum post, plus a verbatim-span check on every claim");
w("- **angles already spent** on that source, so a draft cannot re-run a hook the account has used");
w("- **today's date and every source's publication date**, because a model has no clock");
w();
w(
  "That last pair matters more than it looks. Without the dates the drafter reaches " +
    "for \"just published\" about a piece from March. Without the source text it welds " +
    "our thesis onto whatever was pinned and attributes it to a named guest. Both " +
    "happened. So when you draft in a chat: **paste the source text in, and say what " +
    "today is.** A claim you cannot point at a passage for should be cut, not softened.",
);
w();
w("---");
w();

// ---------------------------------------------------------------- positioning
w("## 1. Positioning, voice and guardrails");
w();
w("This is the drafter's system prompt, verbatim.");
w();
fence(POSITIONING_BRIEF);
w("---");
w();

// ---------------------------------------------------------------- form
w("## 2. Form and length");
w();
w("Handed to the drafter on every call, before anything else.");
w();
fence(formBlock());
w("### The three bands");
w();
w("| Band | Size | When |");
w("| --- | --- | --- |");
for (const b of LENGTH_BANDS) w(`| ${b.label} | ${b.chars} | ${b.when} |`);
w();
w("---");
w();

// ---------------------------------------------------------------- pillars
w("## 3. The nine content pillars");
w();
w(
  "Each pillar gets its own construction rules. `Form` is a length steer only, " +
    "never a licence to split a post.",
);
w();
for (const t of TEMPLATE_DEFS) {
  const s = PILLAR_SHAPES[t.id];
  w(`### ${t.label}`);
  w();
  w(`\`${t.id}\` · flagged stale after ${t.staleDays === 9999 ? "never" : `${t.staleDays} days`}`);
  w();
  w(`**What belongs here.** ${t.description}`);
  w();
  if (s) {
    w(`**Form.** ${s.form}`);
    w();
    w(`**Build.** ${s.build}`);
    w();
    w(`**What earns the copy-link share here.** ${s.citable}`);
    w();
    w(`**Avoid.** ${s.avoid}`);
    w();
  }
}
w("---");
w();

// ---------------------------------------------------------------- icps
w("## 4. Who you are writing for");
w();
w(
  "One post, one ICP. The app names the door a draft is walking through in its " +
    "rationale, and you should too.",
);
w();
for (const i of ICP_DEFS) {
  w(`### ${i.label}`);
  w();
  w(`\`${i.id}\` · ${i.side} door${i.solutionsSlug ? ` · docs.eco.com/solutions/${i.solutionsSlug}` : ""}`);
  w();
  w(i.brief);
  w();
}
w("---");
w();

// ---------------------------------------------------------------- products
w("## 5. Products");
w();
w("The brief is what the product IS. A guardrail is a hard constraint, not a preference.");
w();
for (const p of PRODUCT_DEFS) {
  w(`### ${p.label}`);
  w();
  w(p.brief);
  w();
  if (p.guardrail) {
    w(`> **Guardrail.** ${p.guardrail}`);
    w();
  }
  w(`*Recognised in copy as:* ${p.terms.map((t) => `\`${t}\``).join(", ")}`);
  w();
}
w("### Product-post shapes");
w();
w("| Shape | What it is |");
w("| --- | --- |");
for (const s of PRODUCT_POST_SHAPES) w(`| ${s.label} | ${s.brief.replace(/\|/g, "\\|")} |`);
w();
w("---");
w();

// ---------------------------------------------------------------- analogs
w("## 6. The tradfi analog curriculum");
w();
w(
  "The concepts our ICP already thinks in. The rule that makes this safe is the " +
    "one below, and it is not optional.",
);
w();
w(
  "> **Borrow the vocabulary, refuse the category.** You can write a whole post " +
    "about payment orchestration without ever implying Eco belongs to that " +
    "category. Eco is the routing and execution layer: never an orchestrator, a " +
    "PSP, a gateway, a prime broker or a bridge.",
);
w();
w(
  "**Structure, every time: the parallel earns the attention and the break IS the " +
    "post.** A draft that only runs the parallel is the \"we're the Stripe of " +
    "stablecoins\" failure this registry exists to prevent. Eco is not named in the " +
    "body; the reader should finish smarter about how money moves and infer the rest.",
);
w();
for (const tier of [1, 2, 3, 4] as AnalogTier[]) {
  const defs = ANALOG_DEFS.filter((a) => a.tier === tier);
  if (!defs.length) continue;
  w(`### ${ANALOG_TIER_LABEL[tier]}`);
  w();
  w(`*${ANALOG_TIER_HINT[tier]}*`);
  w();
  for (const a of defs) {
    w(`#### ${a.label}`);
    w();
    w(`\`${a.id}\` · ${a.side} door · ICPs: ${a.icps.join(", ")} · break strength ${a.breakStrength}/3`);
    w();
    w(`**The parallel.** ${a.parallel}`);
    w();
    w(`**Where it breaks.** ${a.breaksWhere}`);
    w();
    if (a.guardrail) {
      w(`> **Guardrail.** ${a.guardrail}`);
      w();
    }
    if (a.sources?.length) {
      w(`*Sources on file:* ${a.sources.map((s) => `[${s.title}](${s.url})`).join(" · ")}`);
      w();
    }
  }
}
w("### Teaching shapes");
w();
w("| Shape | What it is |");
w("| --- | --- |");
for (const s of EDUCATION_SHAPES) w(`| ${s.label} | ${s.brief.replace(/\|/g, "\\|")} |`);
w();
w("---");
w();

// ---------------------------------------------------------------- anti-slop
w("## 7. The anti-slop standard");
w();
w(
  "Handed to the drafter on every call. `ANTI-SLOP.md` in the repo is the fuller " +
    "version, including which source each rule came from and the commodity-zone " +
    "tier that is checked in code after a draft comes back.",
);
w();
fence(ANTI_SLOP_BRIEF);
w("---");
w();

// ---------------------------------------------------------------- contract
w("## 8. What a finished draft looks like");
w();
w("The app asks for 2 to 3 options as JSON. Drafting by hand, the parts that still apply:");
w();
// BAND_CONTRACT's entries are wrapped for source readability, not semantically
// separate, so bulleting each line splits a sentence mid-clause. Joined into a
// paragraph it reads correctly and assumes nothing about the wrapping.
w(BAND_CONTRACT.join(" ").replace(/\s+/g, " ").trim());
w();
w("### Score before you hand it over");
w();
w(SCORING_RUBRIC[0]);
w();
for (const line of SCORING_RUBRIC.slice(1, -1)) w(`- ${line.trim()}`);
w();
w(SCORING_RUBRIC[SCORING_RUBRIC.length - 1]);
w();
w(
  "And the question underneath all of them: **would a treasury operator or a solver " +
    "dev paste this into a work channel?** Copy-link shares are the highest-weighted " +
    "action on the platform at 20.0, worth 40x a like. That is the only score that matters.",
);
w();

const target = process.argv[2] ?? "COPY-BRIEF.md";
writeFileSync(target, out.join("\n").replace(/\n{4,}/g, "\n\n\n") + "\n");
console.log(`wrote ${target}  (${out.join("\n").length.toLocaleString()} chars)`);
