import Anthropic from "@anthropic-ai/sdk";
import { POSITIONING_BRIEF } from "./positioning";
import { TEMPLATE_BY_ID, type Template } from "./taxonomy";
import { chainLabel } from "./dimensions";

// In-tool "draft starting copy" — turns a prioritized recommendation into 2-3
// on-brand X post options the operator can take to 90/10. NOT a finished-post
// generator (Jay's caution: a full generator "over-complicated things"); this
// hands back a starting point grounded in the pillar, the chosen chain, the
// proven post it's building on, and Eco's positioning + X-algo rules.

// Match the model the classifier already uses successfully with this SDK/key.
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
  angle?: string | null; // optional free-text steer from the operator
  basePostText?: string | null; // the proven post this pillar suggested, to build on
}

function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

export async function generateCopy(input: GenerateCopyInput): Promise<CopyOption[]> {
  const def = TEMPLATE_BY_ID[input.template];
  const chain = input.chain ? chainLabel(input.chain) : null;

  const context = [
    `Content pillar: ${def.label} — ${def.description}`,
    chain ? `Chain/topic to feature: ${chain}` : null,
    input.angle ? `Operator's steer: ${input.angle}` : null,
    input.basePostText
      ? `A proven past post in this pillar (build on its idea, don't copy it verbatim):\n"""${input.basePostText.slice(0, 800)}"""`
      : null,
    "",
    "Return 2-3 distinct starting-point drafts as STRICT JSON only, no prose, no code fences:",
    `[{"angle": "<short label>", "text": "<the draft post>", "rationale": "<one line: which ICP + pillar, why this hook>"}]`,
    "Each draft targets ONE ICP. Vary the angle across drafts. Keep them tight and reply-baiting per the X rules.",
  ]
    .filter(Boolean)
    .join("\n");

  const msg = await client().messages.create({
    model: MODEL,
    max_tokens: 1500,
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
