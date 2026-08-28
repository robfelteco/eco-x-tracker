import { ANALOG_BY_ID, type AnalogDef } from "./analogs.ts";

// Question mining — the demand side of the curriculum.
//
// Jay's instruction was not "go find topics." It was: "you need to dig deep and
// find more questions so then you can find ways to answer them," and "I would
// honestly just youtube farm, keep searching key phrases relevant, and follow
// the rabbithole." That is DEMAND discovery, and it is a different search from
// the one lib/discover.ts runs.
//
//   discover.ts  → what HAPPENED (news, ranked by freshness) → a post subject
//   questions.ts → what people ASK (demand, ranked by recurrence) → a post ANGLE
//
// Why this matters more than it looks: without it the curriculum is twenty
// posts and then it is finished. With it, each concept generates a renewable
// set of angles, because the questions people ask about correspondent banking
// change as the market changes even though the mechanism does not.
//
// The ranking rule is the whole idea: an unanswered question that keeps
// recurring is, by definition, the best post available. A question everyone has
// already answered well is worth nothing to us no matter how popular it is.

const XAI_MODEL = "grok-4.3";

export interface MinedQuestion {
  /** The question as people actually phrase it, not as we would phrase it. */
  question: string;
  /** Where it keeps coming up: "YouTube comments", "r/payments", "X replies". */
  askedWhere: string;
  /** "recurring" | "occasional" — how often this shows up across sources. */
  frequency: string;
  /** Is there already a good public answer? The gap is the opportunity. */
  answeredWell: boolean;
  /** The angle an @eco post would take to answer it. */
  angle: string;
  /** Who is asking — maps loosely onto the concept's ICPs. */
  asker: string;
  source?: { title: string; url: string };
}

function buildPrompt(def: AnalogDef, count: number, excludeQuestions: string[]): string {
  const exclusion = excludeQuestions.length
    ? `\nWe have ALREADY answered these — do not return them or near-duplicates:\n${excludeQuestions
        .slice(0, 20)
        .map((q) => `- ${q}`)
        .join("\n")}\n`
    : "";

  return `You are doing audience research for @eco, a stablecoin infrastructure company. We are building educational content that teaches traditional money-movement mechanisms to an institutional and developer audience.

THE CONCEPT: ${def.label}
What it is: ${def.parallel}
Vocabulary people use around it: ${def.vocab.join(", ")}
Who we care about reaching: ${def.icps.join(", ")} (${def.side} audience)

YOUR JOB: find the QUESTIONS real people actually ask about this concept. Not topics — questions, in the words they use. Search YouTube (titles, and what commenters ask), X, Reddit, Stack Exchange, industry forums, and Google's own "people also ask" surface area. Follow the thread: a good question usually has three worse-phrased versions of itself nearby.
${exclusion}
RANK BY OPPORTUNITY, not popularity. The best question is one that RECURS across sources and has NO good public answer. A heavily-answered question is worth nothing to us however popular it is. Be honest in \`answeredWell\` — if there is a clear, well-ranked explainer already, say so.

Prefer questions that reveal a misunderstanding or a hidden cost, because those make the strongest posts. Questions from practitioners beat questions from students.

Return ONLY a JSON object (no prose, no code fences):
{"questions":[{
  "question":"the question in the asker's own words",
  "askedWhere":"where it recurs, e.g. \\"YouTube comments + r/fintech\\"",
  "frequency":"recurring" | "occasional",
  "answeredWell": true | false,
  "angle":"how an @eco post would answer it — one line, specific",
  "asker":"who asks it, e.g. \\"treasury operators\\", \\"backend devs new to payments\\"",
  "source":{"title":"where you saw it","url":"https://real-url"}
}]}
Return at most ${count}. Only real, findable questions — do not invent plausible-sounding ones. Omit \`source\` rather than fabricating a URL.`;
}

function parseQuestions(text: string): MinedQuestion[] {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) return [];
  try {
    const obj = JSON.parse(t.slice(start, end + 1));
    const list = Array.isArray(obj?.questions) ? obj.questions : [];
    return list
      .map((q: Record<string, unknown>) => {
        const src = (q.source ?? null) as Record<string, unknown> | null;
        const url = src ? String(src.url ?? "").trim() : "";
        return {
          question: String(q.question ?? "").trim(),
          askedWhere: String(q.askedWhere ?? "").trim(),
          frequency: q.frequency === "recurring" ? "recurring" : "occasional",
          answeredWell: q.answeredWell === true,
          angle: String(q.angle ?? "").trim(),
          asker: String(q.asker ?? "").trim(),
          source: url ? { title: String(src?.title || url).trim(), url } : undefined,
        };
      })
      .filter((q: MinedQuestion) => q.question && q.angle);
  } catch {
    return [];
  }
}

export interface MineResult {
  questions: MinedQuestion[];
  warnings: string[];
}

// One concept per call. Unlike discover()'s three-lens fan-out this is
// deliberately narrow: the operator has already picked which mechanism they
// want to teach, and a fan-out would just dilute the search across concepts
// they did not ask about.
export async function mineQuestions(
  analogId: string,
  excludeQuestions: string[] = [],
  count = 6,
): Promise<MineResult> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("XAI_API_KEY is not set");
  const def = ANALOG_BY_ID[analogId];
  if (!def) throw new Error(`Unknown concept: ${analogId}`);

  const res = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    signal: AbortSignal.timeout(200_000),
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: XAI_MODEL,
      stream: false,
      input: [{ role: "user", content: buildPrompt(def, count, excludeQuestions) }],
      tools: [{ type: "web_search" }, { type: "x_search" }],
    }),
  });
  if (!res.ok) throw new Error(`xAI ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  const output: unknown[] = Array.isArray(data.output) ? data.output : [];
  const message = output.find(
    (o): o is { type?: string; content: { type: string; text?: string }[] } =>
      typeof o === "object" && o !== null && (o as { type?: string }).type === "message",
  );
  const block = message?.content?.find((c) => c.type === "output_text");
  const questions = parseQuestions(block?.text ?? "");

  // Unanswered and recurring first — the ranking IS the product here.
  questions.sort((a, b) => {
    const rank = (q: MinedQuestion) => (q.answeredWell ? 2 : 0) + (q.frequency === "recurring" ? 0 : 1);
    return rank(a) - rank(b);
  });

  const warnings: string[] = [];
  if (!questions.length) warnings.push("No questions came back — try a broader concept or re-run.");

  return { questions: questions.slice(0, count), warnings };
}
