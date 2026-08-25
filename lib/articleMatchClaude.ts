import Anthropic from "@anthropic-ai/sdk";
import type { AttributionPost, ArticleLite } from "./articleAttribution.ts";

// The last rung of the article-attribution ladder (lib/articleAttribution.ts).
//
// Used only for posts no deterministic rule could place — in practice the
// re-amplifications of an article hosted on the CEO's own X account, which
// never appears in `posts` and therefore has no anchor row to inherit from.
//
// Two rules make this safe rather than a source of quiet wrong data:
//   1. It only ever picks from the seeded registry. It cannot invent an article.
//   2. It is told to return null when unsure, and null is a fine answer — an
//      unattributed post shows in the shelf's residual group, which is honest.

const MODEL = "claude-sonnet-4-6";
const CLAUDE_IN_PER_MTOK = 3;
const CLAUDE_OUT_PER_MTOK = 15;

// Below this the post stays unattributed. Deliberately high: a wrong article
// silently merges two different pieces' metrics, which is worse than a gap.
export const CLAUDE_MATCH_THRESHOLD = 0.75;

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
    _client = new Anthropic();
  }
  return _client;
}

// Extract the first flat {...} object from a blob of text. Our reply schema has
// no nesting, so first-brace-to-first-brace is exact.
function parseFirstObject(raw: string): { article_id?: number | null; confidence?: number; why?: string } | null {
  const start = raw.indexOf("{");
  const end = raw.indexOf("}", start + 1);
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

export interface MatchCost {
  usd: number;
}

export function makeClaudeMatcher(cost: MatchCost) {
  return async function claudeMatch(
    group: AttributionPost[],
    articles: ArticleLite[],
  ): Promise<{ articleId: number; confidence: number } | null> {
    const debug = !!process.env.ARTICLE_MATCH_DEBUG;
    if (!group.length) return null;

    // Title + dek alone is not enough to tell these apart — every Eco article
    // shares the same vocabulary. The opening of the body is what actually
    // distinguishes "WTF Is Orchestration" from "(Smarter) Infrastructure
    // Powers (Smarter) Economies", so it goes in.
    const registry = articles
      .map((a) =>
        [
          `--- ARTICLE ${a.id} [${a.kind}] ---`,
          `Title: ${a.title}`,
          a.dek ? `Standfirst: ${a.dek}` : null,
          a.body ? `Opening:\n${a.body.slice(0, 1400)}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n\n");

    // Every post in the group links to the same place, so they are evidence
    // about the same article. Show them all.
    const evidence = group
      .map((p, i) => `Post ${i + 1} (${p.id}):\n"""${p.text.slice(0, 1200)}"""`)
      .join("\n\n");

    {
      const msg = await client().messages.create({
        model: MODEL,
        max_tokens: 400,
        system: [
          "You match an @eco X post to the ONE article on file that it is amplifying.",
          "Eco is a stablecoin infrastructure company. Its account regularly posts several different",
          "takes pointing back at the same underlying article over a period of weeks — your job is to",
          "work out which article a given post is pointing at, from its argument and vocabulary.",
          "",
          "Articles on file:",
          registry,
          "",
          "Rules:",
          "- Choose ONLY from the numbered list. Never invent an article.",
          "- Match on the SUBSTANCE of the argument, not on shared stablecoin vocabulary. Most of these",
          "  posts share words like stablecoin, chain, liquidity, settlement; that is not evidence.",
          "- If the post is making its own standalone point and is not amplifying any article on file,",
          "  return null. null is a good answer — a wrong match corrupts that article's metrics.",
          "- Be conservative. Confidence below 0.75 will be discarded anyway.",
          "",
          'Return STRICT JSON only, no prose, no code fences: {"article_id": <number|null>, "confidence": 0.0-1.0, "why": "one short sentence"}',
        ].join("\n"),
        messages: [
          {
            role: "user",
            content:
              group.length > 1
                ? `These ${group.length} @eco posts all point at the same source, so they are amplifying the SAME article. Which one?\n\n${evidence}`
                : evidence,
          },
        ],
      });
      if (msg.usage) {
        cost.usd += (msg.usage.input_tokens * CLAUDE_IN_PER_MTOK + msg.usage.output_tokens * CLAUDE_OUT_PER_MTOK) / 1_000_000;
      }
      const textOut = msg.content.find((b) => b.type === "text");
      const raw = textOut && textOut.type === "text" ? textOut.text : "";
      let parsed: { article_id?: number | null; confidence?: number; why?: string };
      try {
        parsed = JSON.parse(stripFences(raw));
      } catch {
        // The model occasionally appends a sentence after the JSON. Take the
        // FIRST object only — a greedy {...} match swallows the trailing prose
        // and throws "Unexpected non-whitespace character after JSON".
        parsed = parseFirstObject(raw) ?? {};
      }
      const id = typeof parsed.article_id === "number" ? parsed.article_id : null;
      const conf = typeof parsed.confidence === "number" ? parsed.confidence : 0;
      if (debug) {
        console.log(`    [match] ${group.length} post(s) → ${id ?? "null"} @${conf} · ${parsed.why ?? ""}`);
        console.log(`            "${group[0].text.replace(/\s+/g, " ").slice(0, 110)}…"`);
      }
      if (id != null && conf >= CLAUDE_MATCH_THRESHOLD && articles.some((a) => Number(a.id) === id)) {
        return { articleId: id, confidence: conf };
      }
    }
    return null;
  };
}
