import { ALL_PRODUCT_TERMS } from "./products.ts";

// Content-template taxonomy — the single source of truth the app codes against.
// Mirrors the `content_template` enum in db/schema.sql. This is OUR taxonomy
// (by content pillar), deliberately NOT Jay's product taxonomy.

export const TEMPLATES = [
  "data_motion_visual",
  "integration_announcement",
  "quote_card",
  "product_post",
  "thought_leadership",
  "dev_doc_post",
  "broad_educational",
  "short_form_video_eco",
  "other",
] as const;

export type Template = (typeof TEMPLATES)[number];

export function isTemplate(v: unknown): v is Template {
  return typeof v === "string" && (TEMPLATES as readonly string[]).includes(v);
}

// How the Prioritize card builds its draft targets for this pillar. This used
// to be INFERRED ("does the pillar have any chain-tagged post?"), which meant a
// single incidental chain tag put Quote Card and Product Posts into chain-angle
// mode — wrong for both. It is now declared per pillar, deliberately.
//   chains    — rank the chains this pillar has covered (New Chain Integrations)
//   products  — rank Eco products × their source articles (Product Posts)
//   articles  — the article shelf, one row per underlying piece (Thought Leadership)
//   discovery — find NEW source material; nothing to re-run (Quote Card, Broad Ed)
//   docs      — the docs.eco.com page shelf, grouped by ICP (Dev Doc Post)
//   videos    — the short-form clip library, grouped by series (Short-Form Video)
//   dmv       — the three data-visual lanes: integrated chain, non-integrated
//               chain, market-wide (Data Motion Visual). It was "generic", the
//               only pillar rotating on nothing, which let a run of chain
//               visuals keep the clock fresh while market-wide data went cold
//               with nowhere to say so. See lib/dmvLanes.ts.
//   generic   — a single "draft something fresh" target
export type DraftMode = "chains" | "products" | "articles" | "discovery" | "docs" | "videos" | "dmv" | "generic";

export interface TemplateDef {
  id: Template;
  label: string;
  description: string;
  draftMode: DraftMode;
  // Per-template staleness threshold (days). The overview page flags a template
  // red once days-since-last-post exceeds this. Tunable per pillar cadence.
  staleDays: number;
  // Which side of the 4-1-1 this pillar lands on (see RATIO_BUCKETS below).
  // Declared per pillar rather than inferred from "does it mention Eco", because
  // a quote card can be an external voice (edu) or an Eco event (soft) and the
  // call is editorial. `null` keeps a pillar out of the meter entirely.
  ratioBucket: RatioBucket | null;
}

// ---------------------------------------------------------------------------
// The 4-1-1. Four educational posts for every soft promo and every hard promo.
//
// The pillar scorer measures each pillar against its own cadence, which cannot
// see the ratio at all: every pillar can be "fresh" while the account runs
// 80% promo, which is what it ran for the 60 days before this went in (16
// educational of 85 main posts). The buckets are what the week strip on
// Prioritize counts, and what the deficit is computed from.
//
// Data Motion Visual is the one pillar that straddles: a market-wide visual
// (no chain as its subject) is educational, a chain visual is a soft promo for
// an integration. lib/ratio.ts splits it per post on `chains`, which is the
// same rule lib/dmvLanes.ts uses to lane them.
// ---------------------------------------------------------------------------
export type RatioBucket = "edu" | "soft" | "hard";

export const RATIO_BUCKETS: Record<RatioBucket, { label: string; target: number; hint: string }> = {
  edu: {
    label: "Educational",
    target: 4,
    hint: "Content the audience would read if Eco did not exist: external market news, mechanism explainers, outside voices.",
  },
  soft: {
    label: "Soft promo",
    target: 1,
    hint: "Eco is in the frame but the post is still worth something on its own: a clip, an essay, a docs walkthrough.",
  },
  hard: {
    label: "Hard promo",
    target: 1,
    hint: "The post exists to announce or sell: a product, an integration, a partner.",
  },
};

export const TEMPLATE_DEFS: TemplateDef[] = [
  {
    id: "data_motion_visual",
    label: "Data Motion Visual",
    description:
      "Animated/motion video presenting market data, charts, or stats (usually stablecoin market numbers). Media is video or GIF; content is a data visualization, not a person or a product demo.",
    draftMode: "dmv",
    staleDays: 10,
    ratioBucket: "soft",
  },
  {
    id: "integration_announcement",
    label: "New Chain Integrations in Eco",
    description:
      "A new BLOCKCHAIN going live in Eco — Eco Routes expanding coverage to a chain. The chain is the subject of the announcement. Signals: 'Eco now supports @chain', 'Eco is live on @chain', 'expanding coverage to <chain>', 'Routes is live on <chain>', chain stats used to justify the integration. NOT a company/partner integrating an Eco product into their own app (that is product_post), and NOT third-party market news about a chain (that is broad_educational).",
    draftMode: "chains",
    staleDays: 14,
    ratioBucket: "hard",
  },
  {
    id: "quote_card",
    label: "Quote Card",
    description:
      "Static image containing a large pulled quote with speaker attribution (name/title/company on the card). Copy typically introduces the speaker and gestures at the quote.",
    draftMode: "discovery",
    staleDays: 14,
    ratioBucket: "edu",
  },
  {
    id: "product_post",
    label: "Product Posts",
    description:
      "Eco product content, in three flavours: (1) PRODUCT RELEASES — a new Eco product or feature shipping; (2) PRODUCT EDUCATION — how a product works, the problem it solves, architecture diagrams, lifecycle explainers, demo footage, eco.com/blog product articles; (3) PARTNERS INTEGRATING ECO infra/products into their own apps (e.g. Para shipping Permit3, LI.FI/Jumper routing through Eco, Circle Gateway powering Eco order size). Signals: Eco product names (Routes, Verified Liquidity, Programmable Addresses, Permit3, Flash Intents, Fast Deposits), eco.com/blog product URLs, architecture diagrams, in-app demo footage, '<partner> integrated <Eco product>'. A partner/company integration belongs HERE — the chain bucket is only for new blockchains going live in Eco.",
    draftMode: "products",
    staleDays: 10,
    ratioBucket: "hard",
  },
  {
    id: "thought_leadership",
    label: "Thought Leadership",
    description:
      "Long-form opinion/perspective articles or posts, often from or featuring our CEO. Essay-like text or links to op-ed style pieces. Includes the many re-amplification posts that point back at an article already published — the tracker groups those by their underlying article rather than counting each as a new piece.",
    draftMode: "articles",
    staleDays: 14,
    ratioBucket: "soft",
  },
  {
    id: "dev_doc_post",
    label: "Dev Doc Post",
    description:
      "Posts driving to developer documentation. Signals: links to docs.eco.com, code snippets, developer-facing language. Optional sub-tag: soft_sell vs hard_sell.",
    draftMode: "docs",
    staleDays: 14,
    ratioBucket: "soft",
  },
  {
    id: "broad_educational",
    label: "Broad Educational",
    description:
      "External stablecoin-market content that never mentions Eco: external articles, external X articles, short clips about what's happening in the stablecoin space. Signals: external link domains, zero Eco/product mentions, market-commentary framing.",
    draftMode: "discovery",
    // Was 10, which told the board one post per ten days was healthy and kept
    // the "4" of the 4-1-1 off the top of Prioritize. At ~10 main posts a week
    // the ratio needs six or seven of these a week, so the cadence is days.
    staleDays: 2,
    ratioBucket: "edu",
  },
  {
    id: "short_form_video_eco",
    label: "Short-Form Video (Eco)",
    description:
      "Short-form video featuring Eco (talking-head clips, event clips, explainers where Eco is named or shown). Distinct from data_motion_visual (data animation) and from product demo videos (which are product_post).",
    draftMode: "videos",
    staleDays: 14,
    ratioBucket: "soft",
  },
  {
    id: "other",
    label: "Other / Review",
    description:
      "Doesn't fit any bucket. Surfaces in the review queue so we can decide whether the taxonomy needs a new bucket.",
    draftMode: "generic",
    staleDays: 9999,
    ratioBucket: null,
  },
];

export const TEMPLATE_BY_ID: Record<Template, TemplateDef> = Object.fromEntries(
  TEMPLATE_DEFS.map((t) => [t.id, t]),
) as Record<Template, TemplateDef>;

// Confidence below this routes a post to the human review queue.
export const REVIEW_THRESHOLD = 0.8;

// Eco product names — used by Stage-1 rules to detect a likely product_post and
// to decide "mentions Eco/product" for the broad_educational rule. Derived from
// the product registry (lib/products.ts) so there is one list, not two.
export const ECO_PRODUCT_TERMS = ALL_PRODUCT_TERMS;

// Domains that count as "Eco-owned" for rule matching.
export const ECO_DOMAINS = ["eco.com", "docs.eco.com"];

// Compact taxonomy block for the Claude prompt (id + description, no staleDays).
export function taxonomyPromptBlock(): string {
  return TEMPLATE_DEFS.map((t) => `- ${t.id}: ${t.description}`).join("\n");
}
