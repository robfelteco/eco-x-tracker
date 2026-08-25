/**
 * Re-decide every post in one or more pillars against the CURRENT taxonomy
 * descriptions (lib/taxonomy.ts). Run this after redefining a pillar.
 *
 *   node --env-file=.env scripts/reclassify.ts integration_announcement
 *   node --env-file=.env scripts/reclassify.ts integration_announcement product_post
 *
 * Auto-applies the result and prints every post that moved, so a bad call is
 * one click to re-file in the review queue.
 */
import { reclassify } from "../lib/classify.ts";
import { isTemplate, TEMPLATE_BY_ID, type Template } from "../lib/taxonomy.ts";

const args = process.argv.slice(2);
if (!args.length) {
  console.error("usage: node --env-file=.env scripts/reclassify.ts <template> [<template>…]");
  process.exit(1);
}
const templates: Template[] = [];
for (const a of args) {
  if (!isTemplate(a)) {
    console.error(`unknown template: ${a}`);
    process.exit(1);
  }
  templates.push(a);
}

console.log(`Re-classifying: ${templates.map((t) => TEMPLATE_BY_ID[t].label).join(", ")}`);
const res = await reclassify(templates);

console.log(`\nReset ${res.reset} posts · rules settled ${res.ruleSettled} · Claude classified ${res.claudeClassified} ($${res.costUsd.toFixed(4)})`);
console.log(`Unchanged: ${res.stayed} · Moved: ${res.flips.length}`);
if (res.flips.length) {
  console.log(`\nMoved:`);
  for (const f of res.flips) {
    const from = f.from ? TEMPLATE_BY_ID[f.from].label : "—";
    const to = f.to ? TEMPLATE_BY_ID[f.to].label : "unclassified";
    console.log(`  ${from} → ${to}  (conf ${f.confidence?.toFixed(2) ?? "—"})`);
    console.log(`    ${f.text.replace(/\s+/g, " ").slice(0, 130)}`);
    console.log(`    ${f.url}`);
  }
}
if (res.errors.length) console.log(`\nErrors:\n  ${res.errors.join("\n  ")}`);
