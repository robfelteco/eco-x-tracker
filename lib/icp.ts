// The ICP registry — who a piece of source material is FOR.
//
// This is the axis the Dev Doc and Short-Form Video shelves group on, and it is
// not invented: docs.eco.com publishes a "Solutions for [persona]" section whose
// eight pages ARE Eco's stated ICPs. We mirror those ids exactly so a docs page
// under /solutions/<x> tags itself, and add one catch-all (`builders`) for the
// Concepts / Architecture / API-Reference pages that are written for a technical
// integrator generally rather than one named persona.
//
// The `side` field carries Robert's framing of the pillar: docs posts target
// "devs AND business/company decision makers who may go there to self-serve an
// integration or learn what Eco has to offer." Those two audiences want opposite
// things from the same page — the drafter needs to know which one it is writing
// for, and the Prioritize card needs to be able to say "you have run the
// technical door six times and never the commercial one."
//
// Kept dependency-free so taxonomy, docs, videos and the backfill scripts can
// all import it without a cycle (same rule as lib/products.ts).

export type IcpSide = "technical" | "commercial" | "both";

export interface IcpDef {
  id: string;
  label: string;
  side: IcpSide;
  // Handed to the copy drafter verbatim. What this reader already believes,
  // what they are trying to do, and what would make them click.
  brief: string;
  // The /solutions/<slug> page that defines this persona, when there is one.
  // Used to auto-tag docs pages without spending a Claude call on them.
  solutionsSlug?: string;
}

export const ICP_DEFS: IcpDef[] = [
  {
    id: "builders",
    label: "Developers & integrators",
    side: "technical",
    brief:
      "A developer evaluating or wiring up an Eco integration. Wants to know what the primitive actually is, what the call looks like, and where the sharp edges are. Rewards precision and code; punishes marketing language. Concepts, architecture and API-reference pages are for this reader.",
  },
  {
    id: "wallets",
    label: "Wallets & consumer apps",
    side: "both",
    brief:
      "A wallet or consumer-app team whose product lives or dies on friction. Network switching, gas-token acquisition and bridge UX are the three places their users drop. Cares about cross-chain transfers, gasless deposits and one-click swaps that the user never has to understand.",
    solutionsSlug: "wallets",
  },
  {
    id: "protocols",
    label: "DeFi protocols",
    side: "technical",
    brief:
      "A protocol team that wants deposits from chains they are not deployed on, and treasury that can rebalance itself. Thinks in terms of effective liquidity depth and one-click cross-chain deposits.",
    solutionsSlug: "protocols",
  },
  {
    id: "payments",
    label: "Payment platforms & PSPs",
    side: "commercial",
    brief:
      "A payments or PSP operator who needs predictable settlement, multi-asset acceptance and compliance — three things stablecoin infrastructure rarely delivers together. Speaks settlement, reconciliation and chargeback risk, not blockspace.",
    solutionsSlug: "payments",
  },
  {
    id: "exchanges",
    label: "Exchanges & onramps",
    side: "commercial",
    brief:
      "An exchange or onramp handling withdrawal flows at volume. Wants auto-routing withdrawal addresses and fewer support tickets from users who withdrew to the wrong chain.",
    solutionsSlug: "exchanges-onramps",
  },
  {
    id: "issuers",
    label: "Stablecoin issuers",
    side: "commercial",
    brief:
      "A stablecoin issuer deciding how their asset moves between chains without minting a wrapped version of itself everywhere. Cares about native cross-chain transfer, distribution reach and not ceding control of their own liquidity.",
    solutionsSlug: "issuers",
  },
  {
    id: "treasury",
    label: "Treasury & yield managers",
    side: "commercial",
    brief:
      "A treasury or yield operator moving size. Slippage on AMM-based routing is a real cost line, manual rebalancing across chains is real headcount, and a failed bridge stranding capital is a real tail risk. Responds to execution quality and operational load, not to decentralization.",
    solutionsSlug: "treasury-yield",
  },
  {
    id: "solvers",
    label: "Solvers & market makers",
    side: "technical",
    brief:
      "A solver or market maker deciding whether filling Eco intents is worth their capital. Cares about capital efficiency, quote competition, and how much inventory they must hold to compete.",
    solutionsSlug: "solvers",
  },
  {
    id: "agents",
    label: "AI agents & autonomous systems",
    side: "technical",
    brief:
      "A team building agents that must transact. Needs bounded authority, predictable outcomes, and one API for cross-chain action instead of per-chain wallet sprawl. The newest and least-covered door.",
    solutionsSlug: "agents",
  },
];

export const ICP_BY_ID: Record<string, IcpDef> = Object.fromEntries(
  ICP_DEFS.map((i) => [i.id, i]),
);

export const ICP_IDS = ICP_DEFS.map((i) => i.id);

export function icpLabel(id: string | null | undefined): string {
  if (!id) return "Unassigned";
  return ICP_BY_ID[id]?.label ?? id;
}

// Auto-tag from the docs path — a /solutions/<slug> page names its own persona,
// so it never needs to cost a Claude call.
export function icpFromSolutionsPath(path: string): string | null {
  const m = path.match(/^\/solutions\/([a-z0-9-]+)/i);
  if (!m) return null;
  const slug = m[1].toLowerCase();
  return ICP_DEFS.find((i) => i.solutionsSlug === slug)?.id ?? null;
}

// Compact block for the Claude tagging prompt.
export function icpPromptBlock(): string {
  return ICP_DEFS.map((i) => `- ${i.id} (${i.side}): ${i.label} — ${i.brief}`).join("\n");
}

// ---------------------------------------------------------------------------
// Postability tier. Without this the docs shelf is 73 rows and "Get Intent
// Status Array" sits next to "Solutions for AI agents" as if they were equally
// postable. They are not.
// ---------------------------------------------------------------------------

export type DocTier = "hero" | "supporting" | "reference";

export const TIER_LABEL: Record<DocTier, string> = {
  hero: "Hero",
  supporting: "Supporting",
  reference: "Reference",
};

export const TIER_HINT: Record<DocTier, string> = {
  hero: "A whole post can be built around this page — it has an argument, not just a parameter table.",
  supporting: "Works as the link under a broader take, but can't carry a post on its own.",
  reference: "Lookup material. Never the subject of a post.",
};

export const TIER_ORDER: Record<DocTier, number> = { hero: 0, supporting: 1, reference: 2 };
