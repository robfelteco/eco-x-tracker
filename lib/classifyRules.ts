import { ECO_PRODUCT_TERMS, type Template } from "./taxonomy";

// Stage-1 deterministic classification. Cheap, runs before any Claude call.
// A rule only SETTLES a post when the signal is unambiguous (high confidence);
// otherwise it returns template=null with a narrowed candidate set for Stage 2.

export interface RuleInput {
  text: string;
  domains: string[];
  mentions: string[];
  media_type: string; // video | photo | animated_gif | link-card | text
  is_reply: boolean;
  is_self_reply: boolean;
  is_quote: boolean;
}

export interface RuleResult {
  template: Template | null; // null → hand to Stage 2 (Claude)
  confidence: number;
  reasoning: string;
  candidates: Template[]; // narrowed set for Stage 2 (all templates if unknown)
}

const ECO_DOMAINS = new Set(["eco.com", "docs.eco.com"]);
// Links that aren't "external articles": X itself + link shorteners we can't resolve.
const NON_ARTICLE_DOMAINS = new Set(["x.com", "twitter.com", "t.co"]);
// Eco-affiliated X handles (lowercased, no @). A post featuring these is Eco
// content even when the literal word "eco" is absent — e.g. @rynesaxe (CEO).
// Extend as more team handles show up.
const ECO_HANDLES = new Set(["eco", "rynesaxe"]);

// Does the text/domains reference Eco or an Eco product? \beco\b avoids matching
// "economy"/"ecosystem"/"record". Product terms, eco domains, and Eco team
// @handles (in the text or the mentions list) also count.
export function mentionsEco(input: RuleInput): boolean {
  const t = input.text.toLowerCase();
  if (/\beco\b/.test(t)) return true;
  if (ECO_PRODUCT_TERMS.some((term) => t.includes(term))) return true;
  if (input.domains.some((d) => ECO_DOMAINS.has(d))) return true;
  if (input.mentions.some((m) => ECO_HANDLES.has(m.toLowerCase()))) return true;
  if ([...ECO_HANDLES].some((h) => t.includes(`@${h}`))) return true;
  return false;
}

function externalArticleDomains(domains: string[]): string[] {
  return domains.filter((d) => d && !ECO_DOMAINS.has(d) && !NON_ARTICLE_DOMAINS.has(d));
}

// Media-type narrowing (from the spec's disambiguation rules).
function candidatesForMedia(media: string): Template[] {
  if (media === "video" || media === "animated_gif")
    return ["data_motion_visual", "product_post", "short_form_video_eco"];
  if (media === "photo") return ["quote_card", "integration_announcement", "product_post"];
  if (media === "link-card") return ["integration_announcement", "product_post", "thought_leadership", "dev_doc_post"];
  return ["thought_leadership", "product_post", "broad_educational"]; // plain text
}

export function classifyByRules(input: RuleInput): RuleResult {
  const domains = input.domains || [];
  const hasDocs = domains.includes("docs.eco.com");
  const ecoBlog = domains.includes("eco.com");
  const external = externalArticleDomains(domains);
  const eco = mentionsEco(input);

  // R1 — docs.eco.com link → dev_doc_post. Unambiguous.
  if (hasDocs) {
    return {
      template: "dev_doc_post",
      confidence: 0.95,
      reasoning: "Links to docs.eco.com (developer documentation).",
      candidates: ["dev_doc_post"],
    };
  }

  // R2 — a STANDALONE post (not a reply) that links out to an external, non-Eco
  // domain AND never mentions Eco/product → broad_educational. Replies are
  // excluded: they're usually source-drops/CTAs on Eco's own threads, not
  // standalone market content, so we leave them for Stage 2.
  if (external.length > 0 && !eco && !input.is_reply) {
    return {
      template: "broad_educational",
      confidence: 0.9,
      reasoning: `Standalone external link (${external[0]}) with no Eco/product mention.`,
      candidates: ["broad_educational"],
    };
  }

  // From here the rules only NARROW — Stage 2 decides. Build a candidate set.
  const candidates = new Set<Template>(candidatesForMedia(input.media_type));

  // eco.com/blog + a partner @-mention → integration vs product (Stage 2 picks).
  if (ecoBlog && input.mentions.some((m) => m !== "eco")) {
    candidates.add("integration_announcement");
    candidates.add("product_post");
  }

  // No media, no link, longer prose → likely thought_leadership (still Stage 2).
  if (input.media_type === "text" && external.length === 0 && !ecoBlog && !hasDocs && input.text.length > 240) {
    candidates.add("thought_leadership");
  }

  // Always allow 'other' as an escape hatch at Stage 2.
  candidates.add("other");

  const reasonBits: string[] = [`media=${input.media_type}`];
  if (eco) reasonBits.push("mentions Eco/product");
  if (external.length) reasonBits.push(`ext=${external[0]}`);
  if (input.is_self_reply) reasonBits.push("self-reply");
  if (input.is_quote) reasonBits.push("quote");

  return {
    template: null, // unsettled → Stage 2
    confidence: 0,
    reasoning: `Rules narrowed only (${reasonBits.join(", ")}).`,
    candidates: [...candidates],
  };
}
