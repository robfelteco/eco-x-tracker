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

export interface TemplateDef {
  id: Template;
  label: string;
  description: string;
  // Per-template staleness threshold (days). The overview page flags a template
  // red once days-since-last-post exceeds this. Tunable per pillar cadence.
  staleDays: number;
}

export const TEMPLATE_DEFS: TemplateDef[] = [
  {
    id: "data_motion_visual",
    label: "Data Motion Visual",
    description:
      "Animated/motion video presenting market data, charts, or stats (usually stablecoin market numbers). Media is video or GIF; content is a data visualization, not a person or a product demo.",
    staleDays: 10,
  },
  {
    id: "integration_announcement",
    label: "Integration Announcement",
    description:
      "Partner or chain integration announcements. Signals: links to eco.com blog, partner @-mentions, language like 'live on', 'integrates', 'now supports', partner logos in media.",
    staleDays: 14,
  },
  {
    id: "quote_card",
    label: "Quote Card",
    description:
      "Static image containing a large pulled quote with speaker attribution (name/title/company on the card). Copy typically introduces the speaker and gestures at the quote.",
    staleDays: 14,
  },
  {
    id: "product_post",
    label: "Product Post",
    description:
      "Eco product content: articles, product diagrams, or videos demoing Eco working inside apps that integrate it. Signals: Eco product names (Routes, Verified Liquidity, Programmable Addresses, Permit3, Flash Intents), architecture diagrams, in-app demo footage.",
    staleDays: 10,
  },
  {
    id: "thought_leadership",
    label: "Thought Leadership",
    description:
      "Long-form opinion/perspective articles or posts, often from or featuring our CEO. Essay-like text or links to op-ed style pieces.",
    staleDays: 14,
  },
  {
    id: "dev_doc_post",
    label: "Dev Doc Post",
    description:
      "Posts driving to developer documentation. Signals: links to docs.eco.com, code snippets, developer-facing language. Optional sub-tag: soft_sell vs hard_sell.",
    staleDays: 14,
  },
  {
    id: "broad_educational",
    label: "Broad Educational",
    description:
      "External stablecoin-market content that never mentions Eco: external articles, external X articles, short clips about what's happening in the stablecoin space. Signals: external link domains, zero Eco/product mentions, market-commentary framing.",
    staleDays: 10,
  },
  {
    id: "short_form_video_eco",
    label: "Short-Form Video (Eco)",
    description:
      "Short-form video featuring Eco (talking-head clips, event clips, explainers where Eco is named or shown). Distinct from data_motion_visual (data animation) and from product demo videos (which are product_post).",
    staleDays: 14,
  },
  {
    id: "other",
    label: "Other / Review",
    description:
      "Doesn't fit any bucket. Surfaces in the review queue so we can decide whether the taxonomy needs a new bucket.",
    staleDays: 9999,
  },
];

export const TEMPLATE_BY_ID: Record<Template, TemplateDef> = Object.fromEntries(
  TEMPLATE_DEFS.map((t) => [t.id, t]),
) as Record<Template, TemplateDef>;

// Confidence below this routes a post to the human review queue.
export const REVIEW_THRESHOLD = 0.8;

// Eco product names — used by Stage-1 rules to detect a likely product_post and
// to decide "mentions Eco/product" for the broad_educational rule.
export const ECO_PRODUCT_TERMS = [
  "routes",
  "verified liquidity",
  "programmable address",
  "permit3",
  "permit 3",
  "flash intents",
  "flash intent",
  "fast deposits",
  "stablecoin economy",
];

// Domains that count as "Eco-owned" for rule matching.
export const ECO_DOMAINS = ["eco.com", "docs.eco.com"];

// Compact taxonomy block for the Claude prompt (id + description, no staleDays).
export function taxonomyPromptBlock(): string {
  return TEMPLATE_DEFS.map((t) => `- ${t.id}: ${t.description}`).join("\n");
}
