import type { RosterPerson } from "./quoteRoster.ts";
import type { Verification } from "./quoteVerify.ts";

// Scoring + auto-disqualifiers — spec §10.
//
//   score = credibility*0.35 + recency*0.15 + quotability*0.25 + pillar_fit*0.25
//
// Disqualified candidates are scored 0 but KEPT in the table, because the unique
// index on quote_hash is what stops a rejected quote resurfacing on the next run.

export interface ScoreInput {
  person: RosterPerson | null;
  orgTier: number | null;
  isCompetitor: boolean;
  saidAt: string | null;
  lookbackDays: number;
  wordCount: number;
  selfContained: boolean;
  singleClaim: boolean;
  pillarTag: string | null; // 'A' | 'B' | 'C' | 'D' | null
  verification: Verification;
  quoteText: string;
  competitorNames: string[];
}

export interface ScoreResult {
  score: number;
  breakdown: Record<string, number>;
  disqualifiers: string[];
}

const TIER_WEIGHT: Record<number, number> = { 1: 1.0, 2: 0.7, 3: 0.4 };
const SENIORITY_WEIGHT: Record<number, number> = { 1: 1.0, 2: 0.8, 3: 0.5 };

// Framing that disqualifies regardless of who said it. These are the things a
// neutral institutional platform must not amplify.
const PRICE_RE = /\b(price target|market cap|moon|pump|all[- ]time high|ath|rally|bull run|bear market|token price|\$[a-z]{2,6} to \$)/i;
const RETAIL_RE = /\b(degen|ape|wagmi|ngmi|gm |fren|hodl|to the moon|diamond hands)\b/i;
const TRIBAL_RE = /\b(ethereum killer|solana killer|evm maxi|flippening|l1 wars|chain war)\b/i;

// --- Learned from the first real review pass -------------------------------
// Robert approved 8 of 38 and rejected 22, every rejection as off_narrative.
// The pattern in the approvals is a claim about the MARKET stated as a general
// truth ("stablecoins have moved from the edge of payments to the mainstream").
// The pattern in the rejections is someone promoting THEIR OWN company, or
// legislative politics. Worth noting: "must contain the word stablecoin" would
// have caught almost none of the rejections — SoFiUSD, MGUSD and the yield/IDI
// quotes all say "stablecoin". The real discriminator is category vs. self.

// Regulatory and legislative process. Adjacent to stablecoins, but it is
// political commentary, not a claim about how money moves.
const POLITICS_RE = /\b(clarity act|genius act|senate|congress|house committee|banking committee|white house|regulator[sy]?\s+(?:environment|framework)|idi\b|insured depository|bank charter|trust bank|occ\b|lower the standard|legislation|bill\b|political cycle|regulatory leadership|administrations)/i;

// First-person promotion of the speaker's own company or product. "We launched",
// "our network", a $TICKER or a product name the speaker owns.
// A branded stablecoin ticker (MGUSD, SoFiUSD, FIUSD). Quoting someone naming
// their own issued asset is inherently promotional. None of the 8 approvals
// contain one; four of the rejections do.
// Mixed-case brands like SoFiUSD need [A-Za-z], not [A-Z][a-z]+. USDC and USDT
// are deliberately EXCLUDED: they are the market's reference assets, and a Visa
// or DoorDash exec naming one is describing the market, not their own product.
const OWN_TICKER_RE = /\b(?!USDC\b|USDT\b)[A-Za-z]{2,8}USD\b/;

// Company milestone / announcement framing. This is what actually separates the
// rejections from the approvals — NOT whether the speaker's employer is named.
// Jack Forestell's approved quote says "Visa is enabling interoperability", so
// naming your own company is fine; announcing your own news is not.
const MILESTONE_RE = /\b(is the first|are the first|just paid|just acquired|can now settle|now settle|is now live|now available|we(?:'re| are) (?:launching|thrilled|proud|announcing)|announcing|years ago,? we|we started|this is the result of|thrilled to|proud to|excited to partner|we(?:'re| are) aligning|uniting together)\b/i;

// Is the quote actually about the stablecoin domain at all? Robert's floor.
// Kept broad enough that "digital dollar" and a named issuer asset still pass.
const DOMAIN_RE = /\b(stablecoin|stablecoins|digital dollar|tokeni[sz]ed (?:deposit|cash|money)|usdc|usdt|onchain (?:dollar|money|payment)|money movement|settlement|clearing)\b/i;

export function scoreCandidate(input: ScoreInput): ScoreResult {
  const disqualifiers: string[] = [];
  // X serves curly apostrophes, so /we're/ never matched "We’re aligning" and the
  // rule silently did nothing. Normalise once, then test everything against it.
  const text = input.quoteText.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');

  if (input.isCompetitor) disqualifiers.push("competitor_org");
  if (input.competitorNames.some((c) => c && new RegExp(`\\b${escapeRe(c)}\\b`, "i").test(text))) {
    disqualifiers.push("praises_competitor");
  }
  if (PRICE_RE.test(text)) disqualifiers.push("price_speculation");
  if (RETAIL_RE.test(text)) disqualifiers.push("retail_framing");
  if (TRIBAL_RE.test(text)) disqualifiers.push("chain_tribalism");
  if (input.verification === "failed") disqualifiers.push("verification_failed");
  if (POLITICS_RE.test(text)) disqualifiers.push("regulatory_politics");
  if (OWN_TICKER_RE.test(text) || MILESTONE_RE.test(text)) {
    disqualifiers.push("self_promotional");
  }

  // Credibility — org tier × seniority. An unknown speaker is capped low until
  // someone adds them to the roster; that cap is what keeps the queue credible.
  const tier = input.orgTier != null ? (TIER_WEIGHT[input.orgTier] ?? 0.4) : null;
  const sen = input.person ? (SENIORITY_WEIGHT[input.person.seniority] ?? 0.5) : null;
  const credibility = tier != null && sen != null ? tier * sen : 0.3;

  // Recency — linear decay over the lookback. The same point made last month
  // beats it made eleven months ago.
  let recency = 0.5;
  if (input.saidAt) {
    const ageDays = (Date.now() - new Date(input.saidAt).getTime()) / 86_400_000;
    recency = Math.max(0, Math.min(1, 1 - ageDays / Math.max(1, input.lookbackDays)));
  }

  // Domain relevance is a PENALTY, not a disqualifier. Robert asked for "the
  // quote should mention stablecoin", and directionally that's right — but
  // replaying it over his own decisions showed it would have killed one of his
  // approvals ("Commerce runs 7 days a week, but moving money has been stuck on
  // a 5-day cycle"), which is on-narrative without using the word. So an
  // off-domain quote sinks down the queue instead of vanishing from it.
  const onDomain = DOMAIN_RE.test(text);

  // Quotability — fits on a card and stands on its own.
  let quotability = 0;
  if (input.selfContained) quotability += 0.4;
  if (input.singleClaim) quotability += 0.3;
  if (input.wordCount >= 12 && input.wordCount <= 40) quotability += 0.3;
  else if (input.wordCount >= 8 && input.wordCount <= 55) quotability += 0.15;

  // Pillar fit — which of Eco's four narrative pillars it serves.
  const pillarFit = input.pillarTag && "ABCD".includes(input.pillarTag) ? 1 : 0;

  const breakdown = {
    credibility: round2(credibility),
    recency: round2(recency),
    quotability: round2(quotability),
    pillarFit: round2(pillarFit),
    onDomain: onDomain ? 1 : 0,
  };

  const raw =
    (credibility * 0.35 + recency * 0.15 + quotability * 0.25 + pillarFit * 0.25) * (onDomain ? 1 : 0.55);
  const score = disqualifiers.length ? 0 : Math.round(raw * 100 * 100) / 100;
  return { score, breakdown, disqualifiers };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Enumerated reject reasons. Captured as an enum, not free text — this data is
// the input to rubric tuning and is worthless as prose (spec §11).
export const REJECT_REASONS = [
  "misattributed",
  "out_of_context",
  "off_narrative",
  "too_long",
  "competitor",
  "already_used",
  "weak_speaker",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const REJECT_LABELS: Record<RejectReason, string> = {
  misattributed: "Misattributed",
  out_of_context: "Out of context",
  off_narrative: "Off-narrative",
  too_long: "Too long",
  competitor: "Competitor",
  already_used: "Already used",
  weak_speaker: "Weak speaker",
};
