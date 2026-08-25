// Eco PRODUCT registry — the axis Product Posts actually rotates on.
//
// Why this exists: the Prioritize page used to offer chain angles for every
// pillar that had a single chain-tagged post. For Product Posts that was wrong
// on the evidence — 34 of 36 posts in the pillar carry no chain tag at all, and
// the one that does (a Solana USDG demo) is incidental. What product posts
// actually rotate on is PRODUCT (Routes / Verified Liquidity / Flash Intents /
// Permit3 / Programmable Addresses / Fast Deposits), the SOURCE ARTICLE behind
// the post, and the post's SHAPE (launch, explainer, diagram, partner demo…).
//
// Kept dependency-free so lib/dimensions.ts, lib/taxonomy.ts and the backfill
// scripts can all import it without a cycle.

export interface ProductDef {
  id: string;
  label: string;
  // One-paragraph fact sheet handed to the copy drafter. Written to be pasted
  // into a prompt: what it IS, who it's for, the mechanism, and the line we
  // must not cross. Without this the drafter only knows the product's NAME and
  // writes generic infra copy.
  brief: string;
  // What we may NOT claim about this product. Roadmap ≠ shipped.
  guardrail?: string;
  // Unambiguous tokens. Matched anywhere, word-boundary aware.
  terms: string[];
  // Ambiguous tokens (ordinary English words). Only matched when the post also
  // mentions Eco, so "routes" in a logistics post never tags the product.
  looseTerms?: string[];
}

export const PRODUCT_DEFS: ProductDef[] = [
  {
    id: "routes",
    label: "Eco Routes",
    brief:
      "Eco Routes is the execution layer for real-time stablecoin sends and swaps across chains. A user or app expresses an intent; an open network of solvers competes to fill it on the destination chain; decentralized prover contracts verify the fill onchain before the solver is paid on the source chain. No trusted operator, no multisig in the middle. One integration reaches every connected chain and major stablecoin. Routes V2 added universal encoding so coverage extends beyond EVM chains. Any-to-Any Swaps (Aug 2026) convert any token on one chain into any token on another, with solvers holding only stablecoins in between.",
    terms: ["eco routes", "routes v2", "routes api", "routes cli", "any-to-any", "any to any swap"],
    looseTerms: ["routes"],
  },
  {
    id: "verified_liquidity",
    label: "Verified Liquidity",
    brief:
      "Eco Verified Liquidity is a permissioned lane on Eco built for regulated institutions. Every liquidity provider is a KYB-authorized legal entity, every transaction is sanctions-screened before it settles, and every transfer ships with counterparty attestations and an audit trail exportable to a compliance system. The pitch is counterparty assurance without giving up onchain execution quality. Audience: exchanges, payment platforms, OTC desks, fintechs, regulated trading desks.",
    guardrail: "Verified Liquidity is in EARLY ACCESS, not general availability. Say 'early access', never 'live for everyone'.",
    terms: ["verified liquidity"],
  },
  {
    id: "flash_intents",
    label: "Flash Intents",
    brief:
      "Flash Intents power same-chain stablecoin swaps at any size. Ordinary intent protocols cap out at whatever inventory a solver happens to hold, so the largest orders go unfilled. Flash Intents remove that constraint: the solver routes the swap using the USER's own capital, atomically and trustlessly, and repays within the same transaction — fronting no liquidity of its own. Every Eco Routes integration inherits it automatically.",
    terms: ["flash intent", "flash intents"],
  },
  {
    id: "permit3",
    label: "Permit3",
    brief:
      "Permit3 extends Permit2 to a multichain world. One EIP-712 signature authorizes token operations across every supported chain at once — no per-chain approval state, no native gas token needed on each chain. Each permission is scoped to exact assets, chains, contracts, and amounts, and expires on a schedule, so what the user approved is exactly what executes. Open source. Shipped in production with Para's Transaction Permissions.",
    terms: ["permit3", "permit 3"],
  },
  {
    id: "programmable_addresses",
    label: "Programmable Addresses",
    brief:
      "Programmable Addresses close the asymmetry that has existed since crypto began: you can program what happens when you SEND money onchain, but not what happens when you RECEIVE it. A Programmable Address is a product-specific address that auto-settles inbound transfers by rules you set — swap, bridge, deposit, or split — executed the moment any sender sends from any chain. Cross-chain deposits are the first live use case.",
    terms: ["programmable address", "programmable addresses"],
  },
  {
    id: "fast_deposits",
    label: "Fast Deposits",
    brief:
      "Fast Deposits move funds into a destination venue or protocol without the user waiting on native bridge finality — the deposit lands immediately and settles behind the scenes. Shipped inside partner stacks (e.g. Circle's Agent Stack uses Eco for fast deposits into Gateway and Nanopayments).",
    terms: ["fast deposit", "fast deposits"],
  },
];

export const PRODUCT_BY_ID: Record<string, ProductDef> = Object.fromEntries(
  PRODUCT_DEFS.map((p) => [p.id, p]),
);

export const PRODUCT_IDS = PRODUCT_DEFS.map((p) => p.id);

export function productLabel(id: string): string {
  return PRODUCT_BY_ID[id]?.label ?? id.replace(/_/g, " ");
}

// Word-boundary test that treats [a-z0-9] as word chars, so "routes" inside
// "reroutes" never matches. Mirrors hasToken() in lib/dimensions.ts.
function hasToken(haystack: string, token: string): boolean {
  const t = token.toLowerCase();
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(t, from);
    if (i === -1) return false;
    const before = haystack[i - 1];
    const after = haystack[i + t.length];
    const wordish = (c: string | undefined) => !!c && /[a-z0-9]/.test(c);
    if (!wordish(before) && !wordish(after)) return true;
    from = i + 1;
  }
}

// Which Eco products does this post talk about? `mentionsEco` gates the loose
// (ordinary-English) terms — see ProductDef.looseTerms.
export function extractProducts(text: string, mentionsEco: boolean): string[] {
  const t = (text || "").toLowerCase();
  const out = new Set<string>();
  for (const p of PRODUCT_DEFS) {
    if (p.terms.some((tok) => hasToken(t, tok))) {
      out.add(p.id);
      continue;
    }
    if (mentionsEco && p.looseTerms?.some((tok) => hasToken(t, tok))) out.add(p.id);
  }
  return [...out].sort();
}

// Flat term list for the Stage-1 rules' "does this mention an Eco product?"
// check (lib/taxonomy.ts re-exports it as ECO_PRODUCT_TERMS).
export const ALL_PRODUCT_TERMS: string[] = PRODUCT_DEFS.flatMap((p) => [...p.terms, ...(p.looseTerms ?? [])]);

// The observed SHAPES a product post takes. Derived by reading all 36 posts in
// the pillar — these are the seven distinct jobs a product post does. The
// drafter picks one; the Prioritize card shows which have gone cold.
export interface PostShape {
  id: string;
  label: string;
  brief: string;
}

export const PRODUCT_POST_SHAPES: PostShape[] = [
  {
    id: "launch",
    label: "Launch / Introducing",
    brief:
      "Announce the release itself. State plainly what is now live, who it is for, and what it replaces. Confident, not press-release-y. Best when the thing is genuinely new.",
  },
  {
    id: "problem_mechanism",
    label: "Problem → mechanism",
    brief:
      "Open on the concrete failure the reader already lives with, in their language, then show the mechanism that removes it. This is the workhorse shape — roughly half the pillar. No product name in the first line.",
  },
  {
    id: "how_it_works",
    label: "How it works (numbered)",
    brief:
      "A short numbered walkthrough of the integration or the flow, 3-4 steps, developer-facing. Ends on what the builder no longer has to do.",
  },
  {
    id: "diagram",
    label: "Architecture / diagram",
    brief:
      "Copy that sets up a visual — an architecture diagram, a lifecycle, a flow chart. The text names the tension the diagram resolves; the image carries the detail. Say what the visual should show.",
  },
  {
    id: "partner_proof",
    label: "Partner in production",
    brief:
      "Proof it is live in someone else's product — a named partner integrating Eco infra. Lead with the partner's outcome, not Eco's feature. Amplify the logo, never claim their credit.",
  },
  {
    id: "icp_objection",
    label: "ICP objection hook",
    brief:
      "Open on the exact objection the target ICP would raise ('a regulated desk can't route through an anonymous counterparty'), then answer it. Carried the entire Verified Liquidity run.",
  },
  {
    id: "article_amplifier",
    label: "Article amplifier",
    brief:
      "Push the underlying article. A tight standalone thesis in the post body that earns the click; the link goes in a reply, never in the primary post.",
  },
];

export const SHAPE_BY_ID: Record<string, PostShape> = Object.fromEntries(
  PRODUCT_POST_SHAPES.map((s) => [s.id, s]),
);

// --- Shape detection -------------------------------------------------------
// Which of the seven jobs is this post doing? Deterministic, derived from
// signals that are actually in the row — no LLM, no extra spend. Only meaningful
// inside product_post; the ordering below is the precedence, most specific
// first. Verified by hand against all 36 posts in the pillar.

export interface ShapeInput {
  text: string;
  mediaType: string;
  linkTitle: string | null;
  mentions: string[]; // lowercased @handles, no leading @
  entities: string[]; // canonical partner ids from lib/dimensions.ts
}

const LAUNCH_RE = /\b(introducing|we're releasing|we are releasing|today,? we're|is now live|are now live|is live in|live in eco|now supports|we're launching|is launching)\b/i;
const NUMBERED_RE = /(^|\n)\s*(?:[1-4][.)]|[-–•])\s+\S/;
const INSTITUTIONAL_RE = /\b(institution|institutional|regulated|compliance|kyb|sanctions|audit|counterparty|desk|treasury|risk committee)\b/i;
const DIAGRAM_RE = /\b(here's the flow|here's the full|lifecycle|under the hood|architecture|breaks down how|the flow)\b/i;

export function detectShape(input: ShapeInput): string {
  const text = (input.text || "").trim();
  // Strip t.co links to judge how much the post actually SAYS.
  const bare = text.replace(/https?:\/\/t\.co\/\w+/g, "").trim();
  const firstLine = bare.split("\n")[0] ?? "";

  // A post whose whole body is a link, carrying an article card, is pushing the
  // article and nothing else.
  if (input.linkTitle && bare.length < 40) return "article_amplifier";

  // A named partner in the mentions, other than us — the post is about their
  // deployment of our product.
  const partner = input.mentions.some((m) => m !== "eco" && m !== "rynesaxe") && input.entities.length > 0;

  if (LAUNCH_RE.test(firstLine)) return "launch";
  if (NUMBERED_RE.test(bare)) return "how_it_works";
  if (partner) return "partner_proof";
  if (firstLine.trim().endsWith("?") && INSTITUTIONAL_RE.test(bare)) return "icp_objection";
  if ((input.mediaType === "photo" || input.mediaType === "animated_gif") && DIAGRAM_RE.test(bare)) return "diagram";
  if (INSTITUTIONAL_RE.test(firstLine)) return "icp_objection";
  if (input.mediaType === "photo" || input.mediaType === "animated_gif") return "diagram";
  return "problem_mechanism";
}
