import {
  stripSponsorReads,
  selectWindows,
  sourceCarriesConcept,
  verifyClaims,
  groundingFindings,
  claimStillAsserted,
} from "../lib/sourceGrounding.ts";
import { ANALOG_BY_ID } from "../lib/analogs.ts";

// Regression check for migration 013, replaying the drafts that caused it.
//
// Rob flagged three drafts arguing DNS/RTGS netting mechanics off a Tokenized
// episode about Citi Token Services, each attributing the thesis to Ryan Rugg,
// who says the opposite. A second set did the same thing to a different
// episode. Both were structurally guaranteed: the drafter got title + summary +
// key_facts and no source text, so it ran the analog registry's thesis and
// bolted the citation on.
//
// The fixture below is real transcript, including the real Fireblocks mid-roll
// (the source of the fabricated "$100 billion" citation) and the real editorial
// lines a good draft SHOULD be able to use. Both directions matter:
//
//   * a fabricated claim must fail          — or the bug ships again
//   * a true claim must pass                — or the gate gets ignored as noisy
//
// The second is not a lesser requirement. The first cut of stripSponsorReads
// ran a char window forward from "brought to you by" and ate 2,884 characters
// of editorial content, which made both TRUE claims unverifiable. A gate that
// cries wolf gets switched off.
//
// Run: npx tsx scripts/check-grounding.ts     (no DB, no network, no model)

const TRANSCRIPT = `
I think if we're successful in this industry and we continue to implement and scale and like again, obfuscate that complexity of blockchain like we will have real-time value of money, stablecoins, tokenized deposits across the ecosystem that truly allows for that atomic settlement and DVP and like rewiring the whole financial system. Welcome to tokenized. My name is Simon Taylor and this is the show focused on stable coins and the institutional adoption of tokenized real world assets.
And reminder number two is this series is brought to you and made possible by our friends at Fireblocks. All right, for those who don't know, I'd love for you to just walk through your career a little bit, Ryan.
And like the strategy I would say overall, the first use case that we went after was liquidity management, right? We had surveyed our top clients about what their real pain point is, they want to be able to move money regardless of weekends, holidays, if it's 4th of July, it doesn't make a difference. They want to be able to move money globally. So that's really where we started and we're live in five branches with two currencies where if it's Saturday, Sunday, Friday 5:00 p.m. and it's 5:00 a.m. in Singapore, clients can now move money.
So the programmability aspect of this technology is really powerful. It's the immutable record, programmability, the 24/7 nature of it. Trade has been notorious for being paper and slow, so automating that whole entire process eases the pain points in the latency within the system.
It's really important. I've definitely been vocal. We wouldn't have needed a blockchain if we weren't intending to connect externally and have kind of a multi-bank strategy. We're also connecting into internal solutions. So we're a corresponding bank for 1,500 different banks. Of that, 300 and plus are on a solution called 24/7 USD clearing.
Tokenized is also sponsored by Fireblocks. Fireblocks is the stablecoin infrastructure of choice for global businesses from Visa to WorldPay to Bridge to Revolut. With over a hundred billion dollars in monthly stablecoin volume, Fireblocks powers stablecoin strategies at scale with infrastructure that enables PSPs, fintechs, remitters, and banks to issue, move, hold, and manage stablecoins. It's all done securely at scale with secure built-in compliance. With Fireblocks, you get complete control to build your own stablecoin orchestration layer, create payment accounts, manage liquidity, and access on and off ramps in over 60 currencies. Makes it easier for you to build and scale and expand your business globally. Learn more at fireblocks.com.
Alrighty, thank you so much to our sponsors. So this time last year we were processing millions, now we're processing billions. So we are seeing really good growth across the ecosystem.
I think the real unlock is when you have true DVP atomic settlement with other assets across the ecosystem. But the problem was there wasn't cash on ledger. Until the advent of stablecoins and tokenized deposits you were going back to traditional rails to settle. So it wasn't truly DVP. You still had that latency within the system.
`.trim();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

console.log("\n1. Sponsor reads are removed, editorial content is not");
const s = stripSponsorReads(TRANSCRIPT);
check("the Fireblocks $100B ad line is gone", !/hundred billion dollars in monthly/i.test(s.body));
check("'Learn more at fireblocks.com' is gone", !/learn more at fireblocks/i.test(s.body));
check("the 1,500 correspondent banks line survives", /1,500 different banks/.test(s.body));
check("the millions-to-billions line survives", /processing billions/.test(s.body));
check("the five-branches line survives", /live in five branches/.test(s.body));
check("strip is surgical, not greedy", s.removed < 1200, `${s.removed} chars across ${s.blocks} block(s)`);

console.log("\n2. A source that never discusses the concept is refused");
// These are the two concepts whose drafts were fabricated. Neither mechanism is
// mentioned anywhere in the episode; generateCopy throws on this rather than
// letting the model bridge the gap from its own priors.
for (const id of ["net_vs_gross", "nostro_vostro"]) {
  const a = ANALOG_BY_ID[id];
  const w = selectWindows(TRANSCRIPT, a.vocab);
  check(`"${a.label}" is not carried by this episode`, !sourceCarriesConcept(w));
}
// The positive control: a concept the episode DOES cover must still retrieve,
// or the gate would block every legitimate draft too.
{
  const w = selectWindows(TRANSCRIPT, ["atomic settlement", "dvp", "tokenized deposits", "24/7"]);
  check("a concept the episode does cover still retrieves", sourceCarriesConcept(w), `${w.length} window(s)`);
}

console.log("\n3. Claims are checked against the source, both directions");
const fabricated = [
  {
    claim: "the nostro/vostro prefunding problem is a capital cost, not a latency one",
    sourceQuote: "the nostro/vostro prefunding problem is a capital cost, not a latency one",
  },
  {
    claim: "A bank trapping $40M overnight in a correspondent account",
    sourceQuote: "trapping $40M overnight in a correspondent account to cover next-day obligations",
  },
  {
    // Real words, real transcript — but the mid-roll, not the guest. Verbatim
    // matching alone would PASS this, which is why the ad strip runs first.
    claim: "Fireblocks reported over $100 billion in monthly stablecoin volume",
    sourceQuote: "With over a hundred billion dollars in monthly stablecoin volume",
  },
];
const trueClaims = [
  {
    claim: "Citi is a correspondent bank for 1,500 banks, 300+ on 24/7 USD clearing",
    sourceQuote: "we're a corresponding bank for 1,500 different banks. Of that, 300 and plus are on a solution called 24/7 USD clearing",
  },
  {
    claim: "Citi went from processing millions to billions in a year",
    sourceQuote: "this time last year we were processing millions, now we're processing billions",
  },
];

for (const v of verifyClaims(fabricated, TRANSCRIPT)) {
  check(`rejected: ${v.claim.slice(0, 54)}`, v.verification === "failed", `${(v.similarity * 100).toFixed(0)}%`);
}
for (const v of verifyClaims(trueClaims, TRANSCRIPT)) {
  check(`accepted: ${v.claim.slice(0, 54)}`, v.verification !== "failed", `${v.verification} ${(v.similarity * 100).toFixed(0)}%`);
}
check(
  "every fabricated claim produces a HARD finding",
  groundingFindings(verifyClaims(fabricated, TRANSCRIPT)).filter((f) => f.severity === "hard").length === 3,
);
check("no findings on the true claims", groundingFindings(verifyClaims(trueClaims, TRANSCRIPT)).length === 0);

console.log("\n4. A repaired draft is re-judged on what it still says");
const claim = "A bank trapping $40M overnight in a correspondent account is paying a liquidity tax";
check("claim detected while still in the post", claimStillAsserted(claim, `Netting is a liquidity tool. ${claim}. Onchain flips the default.`));
check("claim gone after the repair deletes it", !claimStillAsserted(claim, "Netting is a liquidity tool. Onchain flips the default."));

console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : "All grounding checks passed."}\n`);
process.exit(failures ? 1 : 0);
