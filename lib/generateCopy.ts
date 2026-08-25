import Anthropic from "@anthropic-ai/sdk";
import { POSITIONING_BRIEF } from "./positioning.ts";
import { TEMPLATE_BY_ID, type Template } from "./taxonomy.ts";
import { chainLabel } from "./dimensions.ts";
import { PRODUCT_BY_ID, SHAPE_BY_ID } from "./products.ts";
import { sql } from "./db.ts";

// In-tool "draft starting copy" — turns a prioritized recommendation into 2-3
// on-brand X post options the operator can take to 90/10. NOT a finished-post
// generator; this hands back a starting point.
//
// What changed, and why: the drafter used to know only the pillar and an
// optional CHAIN. For Product Posts that was the wrong axis entirely (34 of 36
// posts in the pillar carry no chain at all), and for article-backed pillars it
// had no idea it was writing the fifth post about the same piece — so it kept
// producing near-duplicates of angles already spent. It now receives:
//   * the PRODUCT and its fact sheet, so drafts are specific rather than generic
//   * the SOURCE ARTICLE's standfirst and body, so it argues from the piece
//   * every PRIOR POST that already used that article, with an explicit
//     instruction that those angles are burned
//   * the requested SHAPE, so "give me the partner-proof version" is a real ask

const MODEL = "claude-sonnet-4-6";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
    _client = new Anthropic();
  }
  return _client;
}

export interface CopyOption {
  angle: string; // short label for the approach ("Institutional hook", "Dev-focused", …)
  text: string; // the draft post
  rationale: string; // one line on why this angle / which ICP + pillar it plays to
}

export interface GenerateCopyInput {
  template: Template;
  chain?: string | null;
  product?: string | null;
  articleId?: number | null;
  shape?: string | null;
  angle?: string | null; // optional free-text steer from the operator
  basePostText?: string | null;
  priorTexts?: string[]; // posts that already used this article
}

function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

interface ArticleContext {
  title: string;
  dek: string | null;
  author: string | null;
  publishedOn: string | null;
  body: string | null;
}

async function loadArticle(id: number): Promise<ArticleContext | null> {
  const rows = await sql<ArticleContext>`
    SELECT title, dek, author, to_char(published_on, 'YYYY-MM-DD') AS "publishedOn", body
    FROM articles WHERE id = ${id}`;
  return rows[0] ?? null;
}

export async function generateCopy(input: GenerateCopyInput): Promise<CopyOption[]> {
  const def = TEMPLATE_BY_ID[input.template];
  const chain = input.chain ? chainLabel(input.chain) : null;
  const product = input.product ? PRODUCT_BY_ID[input.product] : null;
  const shape = input.shape ? SHAPE_BY_ID[input.shape] : null;
  const article = input.articleId ? await loadArticle(input.articleId) : null;

  const priors = (input.priorTexts ?? []).filter((t) => t && t.trim().length > 20).slice(0, 6);

  const context = [
    `Content pillar: ${def.label} — ${def.description}`,

    product
      ? [
          `PRODUCT this post is about: ${product.label}`,
          product.brief,
          product.guardrail ? `HARD CONSTRAINT: ${product.guardrail}` : null,
        ]
          .filter(Boolean)
          .join("\n")
      : null,

    // A chain is only ever a colour here, never the subject — unless the pillar
    // IS chain integrations.
    chain
      ? input.template === "integration_announcement"
        ? `CHAIN going live in Eco: ${chain}. This is the subject of the post.`
        : `Chain that may be worth naming: ${chain}. Only mention it if it genuinely sharpens the post — this pillar is not about chains.`
      : null,

    article
      ? [
          `SOURCE ARTICLE this post points at:`,
          `  Title: ${article.title}`,
          article.dek ? `  Standfirst: ${article.dek}` : null,
          article.author ? `  Author: ${article.author}` : null,
          article.publishedOn ? `  Published: ${article.publishedOn}` : null,
          article.body ? `  Body (excerpt):\n"""${article.body.slice(0, 5000)}"""` : null,
          `Argue FROM this piece. Pull a specific claim out of it — do not summarise the whole thing.`,
        ]
          .filter(Boolean)
          .join("\n")
      : null,

    // The single most important addition. Without this the drafter reinvents
    // whichever angle is most obvious, which is exactly the angle already used.
    priors.length
      ? [
          `ANGLES ALREADY SPENT — this article has been posted ${priors.length === 1 ? "once" : `${priors.length} times`} already:`,
          ...priors.map((t, i) => `  ${i + 1}. ${t.replace(/\s+/g, " ").slice(0, 300)}`),
          `Do NOT re-run any of those angles, hooks, or opening lines. Find a claim in the article that none of them used.`,
          `If the piece genuinely has no fresh angle left, say so in the rationale rather than producing a near-duplicate.`,
        ].join("\n")
      : null,

    shape ? `SHAPE requested: ${shape.label} — ${shape.brief}` : null,
    input.angle ? `Operator's steer: ${input.angle}` : null,

    !article && input.basePostText
      ? `A proven past post in this pillar (build on its idea, don't copy it verbatim):\n"""${input.basePostText.slice(0, 800)}"""`
      : null,

    "",
    "Return 2-3 distinct starting-point drafts as STRICT JSON only, no prose, no code fences:",
    `[{"angle": "<short label>", "text": "<the draft post>", "rationale": "<one line: which ICP + pillar, why this hook>"}]`,
    "Each draft targets ONE ICP. Vary the angle across drafts. Keep them tight and reply-baiting per the X rules.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const msg = await client().messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: POSITIONING_BRIEF,
    messages: [{ role: "user", content: context }],
  });

  const textOut = msg.content.find((b) => b.type === "text");
  const raw = textOut && textOut.type === "text" ? textOut.text : "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    const m = raw.match(/\[[\s\S]*\]/);
    parsed = m ? JSON.parse(m[0]) : [];
  }

  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((o): o is CopyOption => !!o && typeof o === "object" && typeof (o as CopyOption).text === "string")
    .map((o) => ({
      angle: String(o.angle ?? "Option").slice(0, 60),
      text: String(o.text).slice(0, 1000),
      rationale: String(o.rationale ?? "").slice(0, 240),
    }))
    .slice(0, 3);
}
