// The output contract and the scoring rubric: what a returned draft must look
// like, and the dimensions the drafter scores itself on before returning.
//
// These lived inline in the context array in lib/generateCopy.ts, which was fine
// while the drafter was the only consumer. It is not the only consumer any more:
// scripts/export-copy-brief.ts publishes the same standard as COPY-BRIEF.md for
// use outside the app, and a second copy of a prompt rule is exactly how three
// files ended up still describing Eco by the June-8 category. One definition,
// two readers.
//
// Kept dependency-free, same rule as lib/products.ts, lib/icp.ts and
// lib/analogs.ts, so anything can import it without pulling in the SDK or the
// database.

// Spread into the prompt array, so each entry stays its own paragraph and the
// assembled prompt is unchanged by the extraction.
export const BAND_CONTRACT: string[] = [
  "Each draft targets ONE ICP. Vary the angle across drafts.",
  `THE THREE "band" VALUES MUST ALL DIFFER: one "tight" (under 280 chars), one "mid"`,
  `(400-900 chars), one "long" (900-2000 chars). Write each draft to the band it`,
  `declares. If the material cannot carry a band, say so in that draft's rationale.`,
];

export const SCORING_RUBRIC: string[] = [
  "SCORE each draft 0-100 before returning it, and let the score change the draft:",
  "  citability (would someone paste this URL into a work channel? this is the 20.0 signal)",
  "  conversational pull (does it earn a considered reply or quote, without bait?)",
  "  dwell value (enough substance to hold attention)",
  "  hook honesty (does the payload deliver what the first line implies?)",
  "  standing out from a feed of stablecoin takes",
  "  slop risk (does it read as machine-written?)",
  "  length fit (is this the right band for the material?)",
  "Anything you would score under 60, rewrite before returning it. Put the weakest dimension in scoreNote.",
];
