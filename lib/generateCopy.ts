import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "child_process";
import { POSITIONING_BRIEF } from "./positioning.ts";
import { TEMPLATE_BY_ID, type Template } from "./taxonomy.ts";
import { chainLabel } from "./dimensions.ts";
import { PRODUCT_BY_ID, SHAPE_BY_ID } from "./products.ts";
import { sql } from "./db.ts";
import { getDocPage } from "./docs.ts";
import { getVideo, speakerLabel } from "./videos.ts";
import { ICP_BY_ID } from "./icp.ts";
import { ANALOG_BY_ID, SHAPE_BY_ID as EDU_SHAPE_BY_ID, TIER_LABEL as ANALOG_TIER_LABEL } from "./analogs.ts";
import { getSourcesFor } from "./analogSources.ts";

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

const MODEL = process.env.COPY_MODEL || "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Two backends, same prompt.
//
//   "cli" → spawn the local `claude` CLI, which authenticates with the Claude
//           Code subscription OAuth profile in ~/.claude. Costs no API credits.
//   "api" → the Anthropic API. Bills ANTHROPIC_API_KEY.
//
// Default: "api" on Vercel (no `claude` binary and no OAuth profile in a
// serverless function — the CLI cannot work there), "cli" everywhere else. That
// mirrors eco-carousel-app: local runs on the subscription, deploys run on the
// key. Override either way with COPY_BACKEND=cli|api.
//
// Note the CLI is slower (process start + a full agent turn vs. one HTTP call)
// and has no structured-output mode, so the JSON comes back as loose text. The
// parse below already tolerates that — it was written for the API's occasional
// fenced output — and the CLI path retries once with a harder instruction.
// ---------------------------------------------------------------------------
export type CopyBackend = "cli" | "api";

function chosenBackend(): CopyBackend {
  const b = process.env.COPY_BACKEND;
  if (b === "cli" || b === "api") return b;
  return process.env.VERCEL ? "api" : "cli";
}

// 300s, not 180s: the CLI retries internally before giving up, so an auth
// failure takes ~190s to surface its real message. A tighter ceiling SIGKILLs
// it first and reports an opaque timeout instead of "Failed to authenticate".
const CLI_TIMEOUT_MS = Number(process.env.COPY_CLI_TIMEOUT_MS || 300_000);

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
  // --- Citation, for curriculum posts ---
  // Split in two because the X rules and the credit requirement pull in
  // opposite directions: an in-body link suppresses reach, but an unsourced
  // claim about how CHIPS settles is worse than a smaller audience. So the
  // BODY credits the source by name and the LINK rides in the first reply,
  // which is where the algorithm wants it anyway.
  sourceTitle?: string; // what the body credits, e.g. "the BIS quarterly review"
  sourceUrl?: string; // the link for the reply
  replyText?: string; // the ready-to-post first reply carrying that link
}

export interface GenerateCopyInput {
  template: Template;
  chain?: string | null;
  product?: string | null;
  articleId?: number | null;
  docPageId?: number | null;
  videoId?: number | null;
  // A tradfi analog concept from lib/analogs.ts. When set, this is a CURRICULUM
  // post: it teaches a mechanism rather than reporting a market signal.
  analogId?: string | null;
  // Which teaching shape to take (EDUCATION_SHAPES). Curriculum posts only —
  // the seven product shapes don't apply to a concept explainer.
  eduShape?: string | null;
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

// --- CLI backend: spawn the local `claude` CLI (subscription auth) ---------
//
// `--tools ""` disables every built-in tool, which turns an agent turn into a
// plain completion: no filesystem access, no wandering, and noticeably faster.
// `--system-prompt` REPLACES Claude Code's own system prompt with the
// positioning brief, so the CLI path sees exactly what the API path sends as
// `system` rather than the brief appended to a coding agent's instructions.
function runClaudeCli(system: string, user: string): Promise<{ text: string; costUsd: number }> {
  const bin = process.env.CLAUDE_BIN || "claude";
  const args = [
    "-p",
    "--output-format", "json",
    "--tools", "",
    "--system-prompt", system,
    "--model", MODEL,
  ];

  return new Promise((resolve, reject) => {
    // Strip the API key so the CLI falls back to subscription OAuth instead of
    // silently billing credits — the whole point of this backend.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    // Also drop the gateway/base-URL overrides. If the dev server was started
    // from inside a Claude Code session, the child inherits that session's
    // ANTHROPIC_BASE_URL and dies with an opaque "Decompression error:
    // ZlibError" instead of talking to the real API.
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_BEDROCK_BASE_URL;
    delete env.ANTHROPIC_VERTEX_BASE_URL;
    // A dev server started from a GUI context often has a minimal PATH, and
    // `claude` installs to ~/.local/bin. Make sure that is reachable.
    if (process.env.HOME) env.PATH = `${process.env.HOME}/.local/bin:${env.PATH ?? ""}`;

    let child;
    try {
      child = spawn(bin, args, { env });
    } catch (e) {
      reject(e);
      return;
    }

    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude CLI timed out after ${Math.round(CLI_TIMEOUT_MS / 1000)}s.`));
    }, CLI_TIMEOUT_MS);

    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e.code === "ENOENT") {
        reject(
          new Error(
            "'claude' CLI not found. Install Claude Code, set CLAUDE_BIN to its path, or set COPY_BACKEND=api to use the API.",
          ),
        );
      } else reject(e);
    });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out) {
        reject(new Error(`claude CLI exited ${code}: ${err.slice(0, 300)}`));
        return;
      }
      try {
        const envelope = JSON.parse(out);
        if (envelope.is_error) {
          reject(new Error(`claude CLI: ${String(envelope.result).slice(0, 300)}`));
          return;
        }
        // On a subscription `total_cost_usd` is what the turn WOULD have cost on
        // the API, not a charge. Surfaced so the saving stays visible.
        resolve({ text: String(envelope.result ?? ""), costUsd: Number(envelope.total_cost_usd) || 0 });
      } catch {
        reject(new Error(`Could not parse claude CLI output: ${out.slice(0, 200)}`));
      }
    });

    child.stdin.write(user);
    child.stdin.end();
  });
}

// Shared by both backends: the model is asked for a bare JSON array, but may
// fence it or wrap it in a sentence. Tolerate both, give up quietly otherwise.
function parseOptions(raw: string): CopyOption[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    const m = raw.match(/\[[\s\S]*\]/);
    try {
      parsed = m ? JSON.parse(m[0]) : [];
    } catch {
      parsed = [];
    }
  }

  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((o): o is CopyOption => !!o && typeof o === "object" && typeof (o as CopyOption).text === "string")
    .map((o) => ({
      angle: String(o.angle ?? "Option").slice(0, 60),
      // 2400, not 1000. The cap is a sanity bound on a runaway generation, but
      // the prompt actively asks for threads (3-8 posts) and curriculum drafts
      // reliably use them — at 1000 chars a five-post thread came back with its
      // closing question cut mid-word, which is exactly the part that earns the
      // replies the X rules are written around.
      text: String(o.text).slice(0, 2400),
      rationale: String(o.rationale ?? "").slice(0, 240),
      sourceTitle: o.sourceTitle ? String(o.sourceTitle).slice(0, 200) : undefined,
      sourceUrl: o.sourceUrl ? String(o.sourceUrl).slice(0, 500) : undefined,
      replyText: o.replyText ? String(o.replyText).slice(0, 500) : undefined,
    }))
    .slice(0, 3);
}


// Belt and braces on the citation. The prompt says "copy the URL exactly", and
// models mostly do — but "mostly" is not good enough for a link we publish, and
// a mis-copied URL is indistinguishable from a real one at a glance. So every
// returned sourceUrl must match a URL we actually verified; if it does not, we
// try to recover it from the title, and failing that we strip the citation
// rather than ship a link nobody checked.
function reconcileSources(options: CopyOption[], sources: { title: string; url: string }[]): CopyOption[] {
  if (!sources.length) return options;
  const byUrl = new Map(sources.map((s) => [s.url.replace(/\/+$/, ""), s]));
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();

  return options.map((o) => {
    if (!o.sourceUrl && !o.sourceTitle) return o;
    const claimed = (o.sourceUrl ?? "").replace(/\/+$/, "");
    let match = byUrl.get(claimed);

    if (!match && o.sourceTitle) {
      const want = norm(o.sourceTitle);
      match =
        sources.find((s) => norm(s.title) === want) ??
        sources.find((s) => norm(s.title).includes(want) || want.includes(norm(s.title)));
    }

    if (!match) {
      console.warn(`[generateCopy] dropped an unverifiable citation: ${o.sourceUrl ?? o.sourceTitle}`);
      return { ...o, sourceUrl: undefined, replyText: undefined };
    }
    // The reply carries the link, so rewrite it around the URL we trust rather
    // than the one the model typed.
    const reply = o.replyText
      ? o.replyText.replace(/https?:\/\/\S+/g, match.url)
      : `Source: ${match.title}\n${match.url}`;
    return { ...o, sourceTitle: match.title, sourceUrl: match.url, replyText: reply };
  });
}

export async function generateCopy(input: GenerateCopyInput): Promise<CopyOption[]> {
  const def = TEMPLATE_BY_ID[input.template];
  const chain = input.chain ? chainLabel(input.chain) : null;
  const product = input.product ? PRODUCT_BY_ID[input.product] : null;
  const shape = input.shape ? SHAPE_BY_ID[input.shape] : null;
  const article = input.articleId ? await loadArticle(input.articleId) : null;
  const docPage = input.docPageId ? await getDocPage(input.docPageId) : null;
  const video = input.videoId ? await getVideo(input.videoId) : null;
  const analog = input.analogId ? ANALOG_BY_ID[input.analogId] : null;
  // Verified source material for this concept. A curriculum draft is not
  // allowed to proceed without it — see the throw below.
  const analogSources = analog ? await getSourcesFor(analog.id) : [];
  const eduShape = input.eduShape ? EDU_SHAPE_BY_ID[input.eduShape] : null;
  // An analog concept names its own ICPs; the first is the primary reader.
  const icpId = docPage?.icp ?? video?.icp ?? analog?.icps[0] ?? null;
  const icp = icpId ? ICP_BY_ID[icpId] : null;

  // No source, no draft. Rob's rule: "we can't just yolo copy without any
  // source material." Failing loudly here is deliberate — silently producing an
  // unsourced explainer is the outcome we are trying to make impossible, and
  // the UI turns this message into a "Find sources" prompt.
  if (analog && analogSources.length === 0) {
    throw new Error(
      `No verified source material for "${analog.label}" yet. Run Find sources on this concept first — ` +
        `curriculum posts must argue from something citable.`,
    );
  }

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
          `ANGLES ALREADY SPENT — this source has been posted ${priors.length === 1 ? "once" : `${priors.length} times`} already:`,
          ...priors.map((t, i) => `  ${i + 1}. ${t.replace(/\s+/g, " ").slice(0, 300)}`),
          `Do NOT re-run any of those angles, hooks, or opening lines. Find a claim in the article that none of them used.`,
          `If the source genuinely has no fresh angle left, say so in the rationale rather than producing a near-duplicate.`,
        ].join("\n")
      : null,

    // The docs page IS the post's subject. Handing over the page body is the
    // same move that made article-backed drafts specific instead of generic:
    // without it the drafter only knows a URL and writes infrastructure filler.
    docPage
      ? [
          `DOCS PAGE this post drives to: ${docPage.url}`,
          `  Title: ${docPage.title}   (section: ${docPage.section})`,
          docPage.blurb ? `  What the docs team says it covers: ${docPage.blurb}` : null,
          docPage.hook ? `  The angle worth taking: ${docPage.hook}` : null,
          docPage.body ? `  Page content (excerpt):\n"""${docPage.body.slice(0, 6000)}"""` : null,
          `Build the post around a SPECIFIC claim, mechanism or pain named on this page.`,
          `Never write a generic "check out our docs" post — the whole point is that this page,`,
          `not the docs homepage, is the destination. Deep-linked posts run roughly double the`,
          `impressions of homepage posts, so the specificity is the strategy.`,
        ]
          .filter(Boolean)
          .join("\n")
      : null,

    // For a clip the transcript is the gold: it is the speaker's own words, and
    // the strongest short-form posts in the corpus quote or paraphrase the line
    // the clip actually turns on rather than describing the clip from outside.
    video
      ? [
          `SHORT-FORM CLIP this post is posting: "${video.title}"`,
          video.durationSec ? `  Length: ${video.durationSec}s` : null,
          // The LABEL, not the raw id: the id is "strao" and drafts were coming
          // back attributing lines to "strao" rather than "@strao_".
          video.speaker ? `  Speaker: ${speakerLabel(video.speaker)}` : null,
          video.topic ? `  Topic: ${video.topic}` : null,
          video.hook ? `  The moment worth building on: ${video.hook}` : null,
          video.description ? `  Summary: ${video.description.slice(0, 900)}` : null,
          video.transcript
            ? `  TRANSCRIPT (the speaker's own words — quote or sharpen a line from here):\n"""${video.transcript.slice(0, 5000)}"""`
            : null,
          `The copy sits ABOVE the video, so it must make someone stop and play it.`,
          `The pillar's proven shape is: a question the clip answers, then who is answering it.`,
          `Refer to people by the exact handle given above (e.g. "@strao_", "@rynesaxe"), never by a bare id.`,
          `Do not describe the clip from outside — lead with the idea inside it.`,
          video.transcript
            ? `You have the transcript, so be specific. A near-verbatim line from it is fair game.`
            : `You do NOT have a transcript, so do not invent a quote or attribute words to anyone.`,
        ]
          .filter(Boolean)
          .join("\n")
      : null,

    // Both new shelves carry an ICP on every row, so the drafter can be told who
    // it is writing for instead of inferring it from the pillar.
    icp
      ? `TARGET ICP for this post: ${icp.label} (${icp.side}).\n${icp.brief}\nWrite for THIS reader specifically, not for a general crypto audience.`
      : null,

    // ------------------------------------------------------------------
    // Curriculum post. The single most important thing here is the ORDER: the
    // parallel earns the reader's attention, and the BREAK is the post. A draft
    // that only runs the parallel is the "we're the Stripe of stablecoins" slop
    // this registry exists to prevent — and it is also how a company
    // accidentally adopts someone else's category, which is exactly what Ryne
    // flagged about anchoring on payment orchestration.
    // ------------------------------------------------------------------
    analog
      ? [
          `THIS IS A CURRICULUM POST — it teaches a mechanism, it does not report news.`,
          `TRADFI CONCEPT: ${analog.label}  (${ANALOG_TIER_LABEL[analog.tier]}, ${analog.side} door)`,
          ``,
          `THE PARALLEL — how the analog maps. Teach this accurately and in its own vocabulary:`,
          `"""${analog.parallel}"""`,
          ``,
          `WHERE IT BREAKS — this is the payoff and the reason the post exists:`,
          `"""${analog.breaksWhere}"""`,
          ``,
          `Structure: earn attention with the parallel, then land the break. A draft that only`,
          `runs the parallel is not usable — the break IS the post.`,
          `Eco is NOT named in the body. This is top-of-funnel: the reader should finish smarter`,
          `about how money moves, and Eco's relevance should be inferable, not stated.`,
          `HARD RULE — borrow the vocabulary, refuse the category. You may write an entire post`,
          `about ${analog.label} without ever implying Eco belongs to that category. Eco is the`,
          `routing and execution layer; never an orchestrator, PSP, gateway, prime broker or bridge.`,
          analog.guardrail ? `CONCEPT GUARDRAIL: ${analog.guardrail}` : null,
          ``,
          `SOURCE MATERIAL — you MUST ground this post in ONE of these and credit it.`,
          `Pick the single source that best supports your angle. Do not blend several.`,
          // Four, not six, and facts capped. The source block is the biggest
          // thing this prompt gained, and a bloated prompt makes the CLI
          // backend's 300s ceiling reachable — which surfaces to the operator
          // as a timeout rather than a draft. Four well-chosen sources are
          // already more than one post can argue from.
          ...analogSources.slice(0, 4).map((sr, i) =>
            [
              `[${i + 1}] ${sr.title}`,
              sr.publisher ? `    Publisher: ${sr.publisher}${sr.publishedOn ? ` (${sr.publishedOn})` : ""}` : null,
              `    Kind: ${sr.kind ?? "article"}   URL: ${sr.url}`,
              sr.summary ? `    What it says: ${sr.summary}` : null,
              sr.keyFacts.length
                ? `    Checkable claims:\n${sr.keyFacts.map((f) => `      - ${f}`).join("\n")}`
                : null,
            ]
              .filter(Boolean)
              .join("\n"),
          ),
          ``,
          `HOW TO USE IT — this is not decoration, it is the spine of the post:`,
          `  * Build the post around a SPECIFIC claim from the source you picked. Prefer a number,`,
          `    a named system, or a dated fact over a general statement.`,
          `  * Never assert a mechanism the source does not support. If you are unsure whether the`,
          `    source backs a claim, leave the claim out. We are teaching people who work in these`,
          `    systems daily; a wrong detail costs more than a weaker post.`,
          `  * CREDIT IT IN THE BODY, by name, not by link — e.g. "the BIS put a number on this",`,
          `    "SWIFT's own documentation describes it this way". In-body links suppress reach, so`,
          `    the link goes in the FIRST REPLY instead, which is where the algorithm wants it.`,
          `  * Return the source you used in "sourceTitle" and "sourceUrl", and write the first`,
          `    reply into "replyText" — a short line plus the bare URL. Copy the URL EXACTLY as`,
          `    given above; never invent, shorten or guess one.`,
        ]
          .filter(Boolean)
          .join("\n")
      : null,

    eduShape
      ? `TEACHING SHAPE requested: ${eduShape.label} — ${eduShape.brief}`
      : analog
        ? `No shape requested — pick the one this concept best supports and name it in the rationale.`
        : null,

    shape ? `SHAPE requested: ${shape.label} — ${shape.brief}` : null,
    input.angle ? `Operator's steer: ${input.angle}` : null,

    !article && !docPage && !video && input.basePostText
      ? `A proven past post in this pillar (build on its idea, don't copy it verbatim):\n"""${input.basePostText.slice(0, 800)}"""`
      : null,

    "",
    "Return 2-3 distinct starting-point drafts as STRICT JSON only, no prose, no code fences:",
    analog
      ? `[{"angle": "<short label>", "text": "<the draft post>", "rationale": "<one line: which ICP, why this hook, which source claim it rests on>", "sourceTitle": "<the source you used>", "sourceUrl": "<its URL, copied exactly>", "replyText": "<the first reply, carrying the link>"}]`
      : `[{"angle": "<short label>", "text": "<the draft post>", "rationale": "<one line: which ICP + pillar, why this hook>"}]`,
    "Each draft targets ONE ICP. Vary the angle across drafts. Keep them tight and reply-baiting per the X rules.",
  ]
    .filter(Boolean)
    .join("\n\n");

  if (chosenBackend() === "cli") {
    // No structured-output mode on the CLI, so a bad parse gets one retry with a
    // blunter instruction before giving up.
    const suffix = "\n\nReturn ONLY the JSON array described above. No prose, no markdown code fences.";
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const nudge =
        attempt === 0
          ? suffix
          : `${suffix}\n\nYour previous output was not valid JSON. Output ONLY the JSON array this time.`;
      try {
        const { text, costUsd } = await runClaudeCli(POSITIONING_BRIEF, context + nudge);
        const options = reconcileSources(parseOptions(text), analogSources);
        if (options.length) {
          // Printed so the operator can SEE which backend served the draft.
          // costUsd is what the turn would have cost on the API — on a
          // subscription it is the saving, not a charge.
          console.log(
            `[generateCopy] backend=cli model=${MODEL} drafts=${options.length} ` +
              `apiCreditsSpent=$0.00 wouldHaveCost=$${costUsd.toFixed(4)}`,
          );
          return options;
        }
        lastErr = new Error("claude CLI returned no usable drafts.");
      } catch (e) {
        lastErr = e;
        // A missing binary or a timeout will not fix itself on retry.
        if (e instanceof Error && (e.message.includes("not found") || e.message.includes("timed out"))) break;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("CLI copy generation failed.");
  }

  const msg = await client().messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: POSITIONING_BRIEF,
    messages: [{ role: "user", content: context }],
  });

  const textOut = msg.content.find((b) => b.type === "text");
  const options = reconcileSources(parseOptions(textOut && textOut.type === "text" ? textOut.text : ""), analogSources);
  // Same line for the API path, so the two are impossible to confuse. Priced
  // from usage rather than guessed.
  const u = msg.usage;
  const spent = u ? (u.input_tokens * 3 + u.output_tokens * 15) / 1_000_000 : 0;
  console.log(
    `[generateCopy] backend=api model=${MODEL} drafts=${options.length} ` +
      `apiCreditsSpent=$${spent.toFixed(4)} (in=${u?.input_tokens ?? "?"} out=${u?.output_tokens ?? "?"})`,
  );
  return options;
}
