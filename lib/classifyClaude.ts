import Anthropic from "@anthropic-ai/sdk";
import { taxonomyPromptBlock, isTemplate, type Template } from "./taxonomy";
import type { RuleInput } from "./classifyRules";

// Stage-2 classification via the Anthropic API (claude-sonnet-4-6, multimodal).
// Model is per the project brief; it's a current model with vision + strong
// instruction following. We parse JSON defensively (strip code fences) rather
// than relying on a specific SDK's structured-output surface.
const MODEL = "claude-sonnet-4-6";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
    _client = new Anthropic();
  }
  return _client;
}

export interface ClaudeInput extends RuleInput {
  preview_image_url: string | null;
  media_urls: string[];
}

export interface FewShot {
  text: string;
  template: Template;
}

export interface ClaudeResult {
  template: Template;
  confidence: number;
  reasoning: string;
  usage?: { input: number; output: number };
}

// Download an image and return an Anthropic base64 image source. The visual is
// essential (quote cards, data visuals, diagrams, demo footage are visually
// distinct in ways text isn't). Best-effort — returns null on any failure so
// classification degrades to text-only.
const IMG_MAX_BYTES = 4_500_000; // stay under the API's ~5MB image cap
const OK_MEDIA = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

async function fetchImage(url: string): Promise<{ media_type: string; data: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    let ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > IMG_MAX_BYTES) return null;
    if (!OK_MEDIA.has(ct)) {
      // Infer from magic bytes when the header lies (X sometimes serves octet-stream).
      if (buf[0] === 0xff && buf[1] === 0xd8) ct = "image/jpeg";
      else if (buf[0] === 0x89 && buf[1] === 0x50) ct = "image/png";
      else if (buf[0] === 0x47 && buf[1] === 0x49) ct = "image/gif";
      else if (buf[0] === 0x52 && buf[1] === 0x49) ct = "image/webp";
      else return null;
    }
    return { media_type: ct, data: buf.toString("base64") };
  } catch {
    return null;
  }
}

// Pick the best image to send: video/gif → preview thumbnail; photo → first media.
function imageUrlFor(post: ClaudeInput): string | null {
  if ((post.media_type === "video" || post.media_type === "animated_gif") && post.preview_image_url) {
    return post.preview_image_url;
  }
  if (post.media_type === "photo" && post.media_urls[0]) return post.media_urls[0];
  return post.preview_image_url || post.media_urls[0] || null;
}

function stripFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function buildSystem(): string {
  return [
    "You classify posts from Eco's X (Twitter) brand account into exactly ONE content template.",
    "Eco is a stablecoin infrastructure company (products: Routes, Verified Liquidity, Programmable Addresses, Permit3, Flash Intents). Its CEO is Ryne Saxe (@rynesaxe).",
    "",
    "Templates:",
    taxonomyPromptBlock(),
    "",
    "Disambiguation rules:",
    "- docs.eco.com link → dev_doc_post.",
    "- External non-Eco link with zero Eco/product mention → broad_educational.",
    "- eco.com blog link + partner @-mention → likely integration_announcement (could be product_post).",
    "- No media, no link, long essay-like text → likely thought_leadership.",
    "- Video/GIF: data animation → data_motion_visual; Eco demo/talking-head/event → short_form_video_eco or product_post (product demo).",
    "- Static image with a big pulled quote + speaker attribution → quote_card.",
    "- If it truly fits nothing, use other.",
    "",
    "Return STRICT JSON only, no prose, no code fences:",
    '{"template": "<one template id>", "confidence": 0.0-1.0, "reasoning": "one sentence"}',
  ].join("\n");
}

type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export async function classifyWithClaude(post: ClaudeInput, fewShots: FewShot[]): Promise<ClaudeResult> {
  const content: Block[] = [];

  if (fewShots.length) {
    content.push({
      type: "text",
      text:
        "Human-verified examples (text → template):\n" +
        fewShots.map((f) => `- ${JSON.stringify(f.text.slice(0, 160))} → ${f.template}`).join("\n"),
    });
  }

  const imgUrl = imageUrlFor(post);
  const img = imgUrl ? await fetchImage(imgUrl) : null;
  if (img) content.push({ type: "image", source: { type: "base64", ...img } });

  const domains = post.domains?.length ? post.domains.join(", ") : "none";
  const mentions = post.mentions?.length ? post.mentions.map((m) => "@" + m).join(", ") : "none";
  content.push({
    type: "text",
    text:
      `Classify this post.\n` +
      `media_type: ${post.media_type}${img ? " (image attached above)" : imgUrl ? " (image unavailable)" : ""}\n` +
      `outbound domains: ${domains}\n` +
      `mentions: ${mentions}\n` +
      `is_reply: ${post.is_reply} · is_self_reply: ${post.is_self_reply} · is_quote: ${post.is_quote}\n` +
      `text:\n${post.text.slice(0, 1500)}`,
  });

  const msg = await client().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: buildSystem(),
    messages: [{ role: "user", content: content as Anthropic.MessageParam["content"] }],
  });

  const textOut = msg.content.find((b) => b.type === "text");
  const raw = textOut && textOut.type === "text" ? textOut.text : "";
  let parsed: { template?: string; confidence?: number; reasoning?: string };
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    // Last-ditch: find the first {...} object in the text.
    const m = raw.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : {};
  }

  const template = isTemplate(parsed.template) ? parsed.template : "other";
  let confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.5;
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;
  // If the model fell back to 'other' or we couldn't parse a template, force review.
  if (!isTemplate(parsed.template)) confidence = Math.min(confidence, 0.3);

  return {
    template,
    confidence,
    reasoning: (parsed.reasoning || "").toString().slice(0, 300),
    usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens },
  };
}
