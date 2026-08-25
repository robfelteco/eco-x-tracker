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

export function scoreCandidate(input: ScoreInput): ScoreResult {
  const disqualifiers: string[] = [];

  if (input.isCompetitor) disqualifiers.push("competitor_org");
  if (input.competitorNames.some((c) => c && new RegExp(`\\b${escapeRe(c)}\\b`, "i").test(input.quoteText))) {
    disqualifiers.push("praises_competitor");
  }
  if (PRICE_RE.test(input.quoteText)) disqualifiers.push("price_speculation");
  if (RETAIL_RE.test(input.quoteText)) disqualifiers.push("retail_framing");
  if (TRIBAL_RE.test(input.quoteText)) disqualifiers.push("chain_tribalism");
  if (input.verification === "failed") disqualifiers.push("verification_failed");

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
  };

  const raw = credibility * 0.35 + recency * 0.15 + quotability * 0.25 + pillarFit * 0.25;
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
