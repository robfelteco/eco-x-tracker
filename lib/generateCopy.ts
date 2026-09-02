import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { POSITIONING_BRIEF } from "./positioning.ts";
import { TEMPLATE_BY_ID, type Template } from "./taxonomy.ts";
import { chainLabel } from "./dimensions.ts";
import { PRODUCT_BY_ID, SHAPE_BY_ID } from "./products.ts";
import { sql } from "./db.ts";
import { getDocPage } from "./docs.ts";
import { getVideo, speakerLabel } from "./videos.ts";
import { ICP_BY_ID } from "./icp.ts";
import { ANALOG_BY_ID, SHAPE_BY_ID as EDU_SHAPE_BY_ID, TIER_LABEL as ANALOG_TIER_LABEL } from "./analogs.ts";
import { sourcesForDrafting, getSourceById, getSourceText, type AnalogSource } from "./analogSources.ts";
import {
  selectWindows,
  sourceCarriesConcept,
  verifyClaims,
  groundingFindings,
  attributionFindings,
  claimStillAsserted,
  type DraftClaim,
  type ClaimVerdict,
} from "./sourceGrounding.ts";
import type { TimedSegment } from "./quoteVerify.ts";
import { pillarShapeBlock } from "./pillarShapes.ts";
import {
  ANTI_SLOP_BRIEF,
  formBlock,
  autoFixSlop,
  sanitizePrompt,
  scanSlop,
  hardFindings,
  findingsForRepair,
  type SlopFinding,
} from "./antiSlop.ts";
import {
  buildSource,
  recencyBlock,
  scanRecency,
  todayIso,
  type RecencyContext,
} from "./recency.ts";

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

// How long to let the CLI run before giving up on it.
//
// A healthy curriculum draft lands in about 55s once "--effort low" and the
// neutral spawn cwd are in play. It is still not reliable: repeated runs of the
// same prompt have come back at 52s, 154s and >240s, so the ceiling is a real
// part of the design rather than a formality.
//
// The value depends on whether there is anywhere to fall back TO:
//
//   API key set  ->  90s. Fail fast and let the API finish the job. The API
//                    path costs about $0.04 and lands in ~15s, so waiting four
//                    minutes for a doomed CLI turn buys nothing. The cost is
//                    that a genuine auth failure (which the CLI takes ~190s of
//                    internal retries to report) now surfaces as a timeout,
//                    with the real message preserved in the fallback log line.
//   no API key   ->  240s, because a slow answer beats no answer and there is
//                    nothing to hand off to.
function cliTimeoutMs(): number {
  const override = Number(process.env.COPY_CLI_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return override;
  return process.env.ANTHROPIC_API_KEY ? 90_000 : 240_000;
}

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
  // ONE POST. The link lives in the body, not a self-reply: no link penalty
  // exists in the August 2026 algorithm and open_link carries +0.2, so the
  // earlier split was costing reach for nothing. Rob: "we are never doing that."
  sourceTitle?: string; // what the body credits, e.g. "the BIS quarterly review"
  sourceUrl?: string; // the URL, which must appear in `text`
  // Self-scored against the x-algo-optimizer rubric in the same call, so it
  // costs nothing extra. Weakly calibrated by nature: useful for ranking the
  // three options against each other, not as an absolute number.
  score?: number;
  scoreNote?: string;
  /** The length band the drafter committed to before writing. */
  band?: "tight" | "mid" | "long";
  // What the linter still flags after the deterministic fixes and the repair
  // pass. Usually empty. Surfaced in the UI so the operator sees WHY a draft is
  // weak instead of only that it scored low.
  slop?: SlopFinding[];
  // Every assertion the draft attributes to its source, each with the verbatim
  // span it rests on. Checked against the persisted source text, not trusted.
  claims?: DraftClaim[];
  // The verdict per claim, so the operator can see WHICH line failed to ground
  // rather than only that something did.
  claimVerdicts?: ClaimVerdict[];
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
  // ONE row from analog_sources. When set, the draft argues from that piece and
  // nothing else — the prompt carries a single source instead of a shortlist to
  // choose from, and the citation is pinned to it.
  //
  // Why this exists: with four sources in one prompt and "pick the single source
  // that best supports your angle", the model picked the SAME one every time —
  // whichever had the strongest quotable fact. Every draft for swift_messaging
  // cited one SWIFT PDF while four other verified sources went unused. Source
  // selection belongs to the operator, one click per source, not to a model
  // silently resolving a shortlist.
  sourceId?: number | null;
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
  /** Set on chain-integration rows: the chain this piece announces. */
  chain: string | null;
  /** The URL a draft must link to. See db/schema.sql migration 010 — for a
   *  chain with an X article this is the @eco STATUS url, because that is what
   *  makes the X composer unfurl the article card. `x.com/i/article/<id>` does
   *  not unfurl, so it is never the link we hand a draft. */
  shareUrl: string | null;
}

async function loadArticle(id: number): Promise<ArticleContext | null> {
  const rows = await sql<ArticleContext>`
    SELECT title, dek, author, to_char(published_on, 'YYYY-MM-DD') AS "publishedOn", body,
           chain, share_url AS "shareUrl"
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
    // THE reason this backend used to time out. Measured 2026-08-28 on one
    // curriculum prompt, same bytes each time:
    //
    //   default  503s   27,878 thinking tokens   (blew the 300s ceiling)
    //   medium   372s   21,263 thinking tokens   (also blew it)
    //   low       53s        0 thinking tokens   (same 3 drafts, same quality)
    //
    // Drafting is not a reasoning task, and the parts that DO need checking are
    // checked in code by lib/antiSlop.ts after the fact. Asking the model to
    // deliberate over a 60-rule standard bought eight minutes of thinking and
    // nothing else. Override with COPY_CLI_EFFORT if a prompt ever needs it.
    "--effort", process.env.COPY_CLI_EFFORT || "low",
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
      // Spawn from a neutral directory, NOT the repo. The CLI loads whatever
      // project context it finds in cwd, and from the repo root that means this
      // project's AGENTS.md (the Next.js rules block) plus its skills: measured
      // at 110-146k cache-creation tokens per call versus ~74k from a temp dir,
      // on a request that needs none of it. The prompt carries everything the
      // drafter needs; the repo context is pure latency and cost.
      child = spawn(bin, args, { env, cwd: tmpdir() });
    } catch (e) {
      reject(e);
      return;
    }

    let out = "";
    let err = "";
    const ceiling = cliTimeoutMs();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude CLI timed out after ${Math.round(ceiling / 1000)}s.`));
    }, ceiling);

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
      band: o.band === "tight" || o.band === "mid" || o.band === "long" ? o.band : undefined,
      // 2400, not 1000. Threads are banned now, but long form in ONE post is
      // explicitly wanted: the top length band runs to 2000 characters and a
      // curriculum post that teaches a mechanism uses it. The cap is a sanity
      // bound on a runaway generation, nothing more. At 1000 a long-form draft
      // came back with its closing question cut mid-word, which is the part
      // that earns the replies the X rules are written around.
      text: String(o.text).slice(0, 2400),
      rationale: String(o.rationale ?? "").slice(0, 240),
      sourceTitle: o.sourceTitle ? String(o.sourceTitle).slice(0, 200) : undefined,
      sourceUrl: o.sourceUrl ? String(o.sourceUrl).slice(0, 500) : undefined,
      score: Number.isFinite(o.score) ? Math.max(0, Math.min(100, Math.round(Number(o.score)))) : undefined,
      scoreNote: o.scoreNote ? String(o.scoreNote).slice(0, 240) : undefined,
      // Every claim the draft attributes to its source, with the span it rests
      // on. Verified against the persisted source text in polish(); a draft
      // that omits the array entirely is treated as claiming nothing, which is
      // itself a hard finding when it also credits a source by name.
      claims: Array.isArray((o as { claims?: unknown }).claims)
        ? ((o as { claims: unknown[] }).claims
            .filter(
              (c): c is DraftClaim =>
                !!c && typeof c === "object" && typeof (c as DraftClaim).sourceQuote === "string",
            )
            .map((c) => ({
              claim: String(c.claim ?? "").slice(0, 400),
              sourceQuote: String(c.sourceQuote ?? "").slice(0, 600),
            }))
            .slice(0, 12) as DraftClaim[])
        : [],
    }))
    .slice(0, 3);
}


// Belt and braces on the LINK for an article-backed post. The prompt names the
// exact URL, and the model mostly obliges — but the failure we actually shipped
// was a draft closing on an invented `https://eco.com/routes`, which reads as a
// real Eco link and unfurls as nothing. For a chain announcement the link is
// not a footnote, it is the post's visual: the @eco status url is what makes X
// render the article card. So the URL is corrected in code rather than trusted.
function enforceLink(options: CopyOption[], url: string, title: string): CopyOption[] {
  const want = url.replace(/\/+$/, "");
  return options.map((o) => {
    const found = o.text.match(/https?:\/\/\S+/g) ?? [];
    let text = o.text;
    if (found.length === 0) {
      text = `${text.trim()}\n\n${url}`;
    } else if (!found.every((u) => u.replace(/[).,]+$/, "").replace(/\/+$/, "") === want)) {
      // Collapse every URL to the right one, then de-duplicate if the model had
      // written the link twice.
      text = text.replace(/https?:\/\/\S+/g, url);
      const parts = text.split(url);
      if (parts.length > 2) text = parts[0] + url + parts.slice(1).join("").replace(/^\s*\n/, "");
    }
    return { ...o, text: text.replace(/[ \t]+\n/g, "\n").trim(), sourceTitle: title, sourceUrl: url };
  });
}

// Belt and braces on the citation. The prompt says "copy the URL exactly", and
// models mostly do — but "mostly" is not good enough for a link we publish, and
// a mis-copied URL is indistinguishable from a real one at a glance. So every
// returned sourceUrl must match a URL we actually verified; if it does not, we
// try to recover it from the title, and failing that we strip the citation
// rather than ship a link nobody checked.
// `pin` is set on the per-source path. There, an unmatched citation is not an
// ambiguity to resolve — the operator already named the piece, so the fix is to
// correct the draft to it rather than strip the citation and ship an unsourced
// post. Only the blended path can genuinely fail to identify what was cited.
function reconcileSources(
  options: CopyOption[],
  sources: { title: string; url: string }[],
  pin?: { title: string; url: string } | null,
): CopyOption[] {
  if (!sources.length) return options;
  const byUrl = new Map(sources.map((s) => [s.url.replace(/\/+$/, ""), s]));
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();

  return options.map((o) => {
    // No citation at all: on the blended path there is nothing to reconcile it
    // against, but a pinned draft still has to carry its source.
    if (!o.sourceUrl && !o.sourceTitle && !pin) return o;
    const claimed = (o.sourceUrl ?? "").replace(/\/+$/, "");
    let match = byUrl.get(claimed);

    if (!match && o.sourceTitle) {
      const want = norm(o.sourceTitle);
      match =
        sources.find((s) => norm(s.title) === want) ??
        sources.find((s) => norm(s.title).includes(want) || want.includes(norm(s.title)));
    }

    if (!match && pin) {
      // The model wandered off the pinned source, or forgot to echo it. Either
      // way the post was written from this piece and gets credited to it.
      console.warn(
        `[generateCopy] pinned citation to "${pin.title}"; the draft claimed ${o.sourceUrl ?? o.sourceTitle ?? "nothing"}`,
      );
      match = pin;
    }

    if (!match) {
      console.warn(`[generateCopy] dropped an unverifiable citation: ${o.sourceUrl ?? o.sourceTitle}`);
      // Strip any URL the model invented out of the body too, rather than
      // publishing a link nobody checked.
      return {
        ...o,
        text: o.text.replace(/https?:\/\/\S+/g, "").replace(/[ \t]+\n/g, "\n").trim(),
        sourceUrl: undefined,
      };
    }

    // The body carries the link now, so the body is what gets corrected. Any
    // URL the model typed is replaced with the one we verified; if it forgot
    // the link entirely, append it on its own line.
    let text = o.text;
    const urls = text.match(/https?:\/\/\S+/g) ?? [];
    if (urls.length === 0) {
      text = `${text.trim()}\n\n${match.url}`;
    } else if (!urls.some((u) => u.replace(/[).,]+$/, "").replace(/\/+$/, "") === match.url.replace(/\/+$/, ""))) {
      text = text.replace(/https?:\/\/\S+/g, match.url);
    }
    return { ...o, text, sourceTitle: match.title, sourceUrl: match.url };
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
  // Verified source material for this concept. Two shapes:
  //
  //   sourceId set  ->  exactly that row. The operator clicked "Draft from this"
  //                     on one piece, or the concept-level fan-out is running
  //                     this source's leg of the click. One source in, one
  //                     source cited.
  //   sourceId null ->  the legacy shortlist (2 canonical + 2 current) and the
  //                     model picks. Still reachable, and still what an operator
  //                     gets if they hit the endpoint without a source.
  //
  // A curriculum draft is not allowed to proceed without material either way,
  // see the throw below.
  const pinnedSource = analog && input.sourceId ? await getSourceById(input.sourceId, analog.id) : null;
  if (analog && input.sourceId && !pinnedSource) {
    throw new Error(
      `Source ${input.sourceId} is not a verified source for "${analog.label}" any more — it may have expired ` +
        `out of the 365-day current window. Reload the shelf and try again.`,
    );
  }
  const analogSources: AnalogSource[] = pinnedSource
    ? [pinnedSource]
    : analog
      ? await sourcesForDrafting(analog.id)
      : [];
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

  // ------------------------------------------------------------------
  // GROUNDING GATE (migration 013). The same rule as above, one level
  // stricter, because "citable" turned out not to mean "read".
  //
  // A verified row proves the URL resolves. It does not prove we hold the
  // piece. Until now the drafter got title + summary + key_facts and no
  // source text at all, while the analog handed it a finished thesis and
  // the prompt told it to credit the source by name. It did exactly that:
  // two Tokenized episodes produced drafts arguing DNS/RTGS netting, a
  // subject neither episode raises, attributed to named guests.
  //
  // So: no persisted text, no draft. This is a hard gate rather than a
  // warning because the failure is invisible in the output — a fabricated
  // attribution reads exactly like a real one.
  // ------------------------------------------------------------------
  if (pinnedSource && !pinnedSource.textDocId) {
    throw new Error(
      `"${pinnedSource.title}" has not been ingested — we hold its metadata but not the piece itself` +
        `${pinnedSource.factsSource === "description" ? ", and its key facts came from a YouTube description rather than the episode" : ""}. ` +
        `Drafting from metadata is what produces posts that cite a source for a claim it never makes. ` +
        `Ingest it first (web: scripts/ingest-analog-sources.ts, podcasts: scripts/sweep-channels.ts), then draft.`,
    );
  }

  // The gate applies to BOTH shapes. On the blended path the model picks one of
  // several sources, so every candidate it can pick must be one we hold — an
  // ungrounded row left in the shortlist is an ungrounded draft waiting to be
  // chosen, and it would arrive with no text to verify against.
  const grounded: { source: AnalogSource; body: string; windows: ReturnType<typeof selectWindows> }[] = [];
  if (analog) {
    // Per-source window budget: one pinned source can afford the whole budget,
    // a shortlist has to share it or the prompt bloats past the CLI's ceiling.
    const budgetChars = pinnedSource ? 7000 : 2600;
    for (const s of analogSources) {
      const text = await getSourceText(s);
      if (!text) continue;
      grounded.push({
        source: s,
        body: text.body,
        // Vocabulary-matched retrieval, not head-truncation. The analog's own
        // term list decides which passages the model sees, so a 55k-char
        // transcript contributes the parts that bear on the concept instead of
        // its first four minutes.
        windows: selectWindows(text.body, analog.vocab ?? [], {
          budgetChars,
          segments: (text.segments as TimedSegment[] | null) ?? null,
        }),
      });
    }
    if (!grounded.length) {
      throw new Error(
        `None of the ${analogSources.length} verified source(s) for "${analog.label}" have been ingested, so ` +
          `there is nothing to argue from and nothing to check a draft against. Run ` +
          `scripts/ingest-analog-sources.ts (web pages) or scripts/sweep-channels.ts (podcasts) first.`,
      );
    }
  }

  // A source can be real, verified, on-topic for the shelf, and still say
  // nothing about THIS mechanism. That is the netting case exactly: a genuine
  // payments podcast that never mentions netting. Drop those rather than let
  // the model bridge the gap from its own priors — and if that empties the
  // list, say so plainly instead of drafting anyway.
  const onTopic = grounded.filter((g) => sourceCarriesConcept(g.windows));
  if (analog && !onTopic.length) {
    const names = grounded.map((g) => `"${g.source.title}"`).slice(0, 3).join(", ");
    throw new Error(
      `${grounded.length === 1 ? `${names} does not discuss` : `None of ${names} discusses`} ${analog.label} — none of the concept's ` +
        `vocabulary (${(analog.vocab ?? []).slice(0, 6).join(", ")}) appears anywhere in the ingested text. ` +
        `Pick a source that actually covers the mechanism, or draft these against a different concept.`,
    );
  }

  // What the model is shown, and what its claims are checked against, are the
  // same text by construction.
  const sourceWindows = onTopic.flatMap((g) => g.windows);
  const verifyCorpus = onTopic.map((g) => g.body).join("\n\n");

  // Same rule as the curriculum shelf, for the same reason. A chain
  // announcement with no article behind it is exactly how this pillar ended up
  // producing confident copy about venue types and execution guarantees that
  // appear in no piece we ever published. Twenty of the twenty-six chains in
  // CHAIN_LABELS have nothing written behind them; those are not draftable
  // until someone writes the piece.
  if (input.template === "integration_announcement" && !article) {
    throw new Error(
      `No integration article for ${chain ?? "this chain"} yet. A chain announcement has to argue from the ` +
        `published piece and link to it — write the blog post first, add the chain to ` +
        `scripts/ingest-chain-articles.ts, and re-run it.`,
    );
  }

  const priors = (input.priorTexts ?? []).filter((t) => t && t.trim().length > 20).slice(0, 6);

  // Every dated thing this draft is allowed to argue from, with its age worked
  // out once and shared by the prompt block and the post-return check. The
  // drafter has no clock: handed a bare "Published: 2026-06-17" it reliably
  // reached for "just published", because nothing in the call said what day it
  // was. See lib/recency.ts.
  const now = new Date();
  const recency: RecencyContext = {
    today: todayIso(now),
    sources: [
      article ? buildSource(`the source article "${article.title}"`, article.publishedOn, article.shareUrl, now) : null,
      ...analogSources.map((sr) =>
        buildSource(sr.publisher ? `${sr.publisher}'s "${sr.title}"` : `"${sr.title}"`, sr.publishedOn, sr.url, now),
      ),
      video ? buildSource(`the video "${video.title}"`, video.ytPublishedOn, video.ytUrl, now) : null,
    ].filter((s): s is NonNullable<typeof s> => s !== null),
  };

  const context = [
    `Content pillar: ${def.label} — ${def.description}`,

    // Per-pillar construction rules (lib/pillarShapes.ts). Placed second on
    // purpose: form before content, because "earn a copy-link share" means
    // something different for a 12-second data animation than for a five-post
    // explainer of correspondent banking.
    pillarShapeBlock(input.template, analog ? "curriculum" : input.template === "broad_educational" ? "news" : undefined),

    // Placed directly after the pillar shape and phrased as an override, because
    // it contradicts what the pillars used to say. Threads are gone: Rob's rule
    // is one post, always, with a healthy mix of lengths across the options.
    formBlock(),

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
          `Every fact in your draft must come from the body above. Do not add capabilities,`,
          `venue types, guarantees or numbers the piece does not state — a reader who opens the`,
          `link should find what you claimed.`,
          // The link is the payload for chain announcements: pasting the @eco
          // status url into the composer unfurls the article card, which is the
          // post's whole visual. A draft that links anywhere else silently
          // costs us that embed.
          article.shareUrl
            ? `LINK — put EXACTLY this URL in the post body, on its own line, and no other URL:\n  ${article.shareUrl}\nNever invent a link, and never substitute a marketing page such as an /routes or /docs URL.`
            : null,
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
          // Two shapes, because the selection question is answered in two
          // different places. When the operator picked the piece, the model's
          // job is to argue from it — not to re-litigate which source to use.
          pinnedSource
            ? `THE SOURCE — this post argues from this ONE piece. It is already chosen; use it.`
            : `SOURCE MATERIAL — you MUST ground this post in ONE of these and credit it.`,
          pinnedSource
            ? `Every draft you return cites THIS source. Do not reach for another piece, and do`
            : `Pick the single source that best supports your angle. Do not blend several.`,
          pinnedSource
            ? `not cite anything you were not given here. If this source cannot carry a claim you`
            : null,
          pinnedSource ? `want to make, drop the claim rather than sourcing it elsewhere.` : null,
          // Facts capped either way. The source block is the biggest thing this
          // prompt gained, and a bloated prompt makes the CLI backend's 300s
          // ceiling reachable — which surfaces to the operator as a timeout
          // rather than a draft. A pinned source is one entry, so the pinned
          // path is the cheaper and faster of the two.
          ...onTopic.slice(0, 4).map(({ source: sr }, i) =>
            [
              pinnedSource ? sr.title : `[${i + 1}] ${sr.title}`,
              sr.publisher ? `    Publisher: ${sr.publisher}${sr.publishedOn ? ` (${sr.publishedOn})` : ""}` : null,
              `    Kind: ${sr.kind ?? "article"}   Tier: ${sr.tier}   URL: ${sr.url}`,
              sr.summary ? `    What it says: ${sr.summary}` : null,
              // key_facts are a NAVIGATION aid, not evidence. For podcasts they
              // were extracted from the YouTube description, which is how
              // sponsor ad copy ("Fireblocks: over $100 billion in monthly
              // stablecoin volume") ended up quoted in drafts as though a guest
              // had said it. Labelled as untrustworthy so the model cannot
              // treat them as citable, and superseded entirely by the passages
              // below when we hold the text.
              sr.keyFacts.length
                ? `    Index terms (NOT quotable, NOT verified, may include sponsor copy — use only to orient):\n` +
                  sr.keyFacts.map((f) => `      - ${f}`).join("\n")
                : null,
            ]
              .filter(Boolean)
              .join("\n"),
          ),
          ``,
          // The passages. This is the evidence, and the ONLY evidence.
          sourceWindows.length
            ? [
                `SOURCE PASSAGES — the actual text of the piece, retrieved on this concept's vocabulary.`,
                `This is the ONLY evidence you have about what the source says. You have not read the rest`,
                `of it, so you do not know what else is in there. Everything you attribute to this source`,
                `must appear below, in these words.`,
                ``,
                ...sourceWindows.map(
                  (w, i) =>
                    `[P${i + 1}${w.startSec != null ? ` @ ${Math.floor(w.startSec / 60)}:${String(Math.floor(w.startSec % 60)).padStart(2, "0")}` : ""}]` +
                    `${w.hits.length ? ` (mentions: ${w.hits.join(", ")})` : ""}\n"""${w.text}"""`,
                ),
              ].join("\n")
            : null,
          ``,
          // The tier guidance only makes sense as a CHOICE between sources. On
          // the pinned path there is nothing to choose, so it becomes a
          // description of what this one piece can and cannot do for the post.
          pinnedSource
            ? pinnedSource.tier === "current"
              ? `This is a CURRENT source: it reports something recent, so lead with the news and let` +
                `\nthe mechanism follow. Teach the mechanism from what this piece actually states.`
              : `This is a CANONICAL source: it explains the mechanism itself and does not expire, so` +
                `\nwrite the evergreen version. Do not manufacture a news hook the piece does not carry.`
            : [
                `CANONICAL sources explain the mechanism and are what make the post CORRECT.`,
                `CURRENT sources report something recent and are what make the post TIMELY.`,
                `The strongest draft uses a CURRENT source for the hook and a CANONICAL one for the`,
                `mechanism underneath it. If only canonical material exists, write the evergreen version.`,
              ].join("\n"),
          ``,
          `HOW TO USE IT, this is not decoration, it is the spine of the post:`,
          pinnedSource
            ? `  * Build the post around a SPECIFIC claim from this source. Prefer a number, a named`
            : `  * Build the post around a SPECIFIC claim from the source you picked. Prefer a number,`,
          pinnedSource
            ? `    system, or a dated fact over a general statement.`
            : `    a named system, or a dated fact over a general statement.`,
          // ------------------------------------------------------------
          // THE SEPARATION. Two bodies of material arrive in this prompt and
          // they have completely different standing:
          //
          //   THE PARALLEL / WHERE IT BREAKS  = Eco's own framing, from our
          //       registry. Correct, ours to assert, NOT the source's.
          //   SOURCE PASSAGES                 = what the cited piece says.
          //
          // Collapsing those two is the whole bug. The model was told to teach
          // the first and credit the second, with no text to check against, so
          // it attributed our thesis to their podcast.
          // ------------------------------------------------------------
          `  * TWO KINDS OF MATERIAL, AND THEY DO NOT MIX:`,
          `      - THE PARALLEL and WHERE IT BREAKS above are OUR analysis. Assert them in our own`,
          `        voice. NEVER write or imply that the source said them, and never put them next to`,
          `        the credit in a way a reader would take as attribution.`,
          `      - The SOURCE PASSAGES are the only thing you may attribute to the source.`,
          `  * Never assert a mechanism the source does not support. If a passage does not say it,`,
          `    the source does not say it — you have not read the rest of the piece, so you cannot`,
          `    assume it is in there. We are teaching people who work in these systems daily; a wrong`,
          `    detail costs more than a weaker post.`,
          `  * If the passages will not carry the argument you want, WRITE A DIFFERENT POST. Do not`,
          `    keep the argument and soften the attribution ("touches on", "gets at", "makes this`,
          `    plain") — that is the failure mode, not the fix.`,
          `  * CREDIT IT BY NAME IN THE BODY only for something a passage actually states, e.g.`,
          `    "the BIS put a number on this", "SWIFT's own documentation describes it this way".`,
          `  * RETURN A "claims" ARRAY. Every factual assertion you attribute to the source gets one`,
          `    entry: the claim as written in your post, plus "sourceQuote" — the passage text it`,
          `    rests on, COPIED VERBATIM from the passages above, long enough to be unambiguous`,
          `    (roughly 10-30 words). These are checked mechanically against the source text. An`,
          `    invented or paraphrased sourceQuote fails the check and the draft is rejected, so`,
          `    copy, do not retype from memory.`,
          `  * A post that asserts only OUR framing and makes no claim about the source returns an`,
          `    empty claims array — and then must not credit the source by name either. That is a`,
          `    legitimate post. Attributing to a source you cannot quote is not.`,
          `  * PUT THE LINK IN THE POST BODY TOO, on its own line. ONE POST: never a self-reply,`,
          `    never "link in reply", never "source below". There is no link penalty in the`,
          `    algorithm and link opens are rewarded, so the reader gets the source where they`,
          `    are already reading. Copy the URL EXACTLY as given above; never invent, shorten`,
          `    or guess one.`,
          pinnedSource
            ? `  * Return this source in "sourceTitle" and "sourceUrl". They are fixed, not a choice.`
            : `  * Return the source you used in "sourceTitle" and "sourceUrl".`,
          // Every draft in a pinned call rests on the SAME piece, so the only
          // axes left are the angle and the length. Said explicitly because the
          // model's instinct with one source is to write the same post three
          // times — which is exactly what the blended path was already doing
          // across four sources.
          pinnedSource
            ? `  * All your drafts share this one source, so make them differ on ANGLE and LENGTH:` +
              `\n    a different reader, a different claim from the piece, a different way in. Three` +
              `\n    paraphrases of one post is a failed response.`
            : null,
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
    // Sits beside the anti-slop standard because it is the same kind of rule:
    // a house standard enforced in code after the fact, so the model is better
    // off being told the constraint than discovering it in a repair round-trip.
    recencyBlock(recency),
    "",
    ANTI_SLOP_BRIEF,
    "",
    "Return 2-3 distinct starting-point drafts as STRICT JSON only, no prose, no code fences:",
    analog
      ? `[{"angle": "<short label>", "text": "<the draft post, link included>", "band": "<tight|mid|long>", "rationale": "<one line: which ICP, why this hook, which source claim it rests on>", "sourceTitle": "<the source you used>", "sourceUrl": "<its URL, copied exactly>", "claims": [{"claim": "<the assertion as written in your post>", "sourceQuote": "<the passage it rests on, copied VERBATIM from the passages above>"}], "score": <0-100>, "scoreNote": "<one line: the weakest dimension>"}]`
      : `[{"angle": "<short label>", "text": "<the draft post>", "band": "<tight|mid|long>", "rationale": "<one line: which ICP + pillar, why this hook>", "score": <0-100>, "scoreNote": "<one line: the weakest dimension>"}]`,
    "Each draft targets ONE ICP. Vary the angle across drafts.",
    // Repeated here, at the very end, because it is the instruction the drafter
    // drops first: left to itself every option comes back long form. Writing the
    // band into the JSON forces the choice before the prose is written.
    `THE THREE "band" VALUES MUST ALL DIFFER: one "tight" (under 280 chars), one "mid"`,
    `(400-900 chars), one "long" (900-2000 chars). Write each draft to the band it`,
    `declares. If the material cannot carry a band, say so in that draft's rationale.`,
    "",
    "SCORE each draft 0-100 before returning it, and let the score change the draft:",
    "  citability (would someone paste this URL into a work channel? this is the 20.0 signal)",
    "  conversational pull (does it earn a considered reply or quote, without bait?)",
    "  dwell value (enough substance to hold attention)",
    "  hook honesty (does the payload deliver what the first line implies?)",
    "  standing out from a feed of stablecoin takes",
    "  slop risk (does it read as machine-written?)",
    "  length fit (is this the right band for the material?)",
    "Anything you would score under 60, rewrite before returning it. Put the weakest dimension in scoreNote.",
  ]
    .filter(Boolean)
    .join("\n\n");

  // Reconcile against the sources the prompt ACTUALLY showed, not every
  // verified row for the concept. An ungrounded source was filtered out
  // upstream; letting a citation resolve back to one would re-attach the exact
  // "cited a piece we never read" property the gate exists to remove.
  const citable = analog ? onTopic.map((g) => g.source) : analogSources;
  const options = reconcileSources(await runBackend(context), citable, pinnedSource);
  // An article-backed post carries the piece's own link, never a marketing page
  // the model reached for. Curriculum posts keep their own reconcile pass.
  const linked = article?.shareUrl ? enforceLink(options, article.shareUrl, article.title) : options;
  return polish(linked, citable, pinnedSource, recency, verifyCorpus || null);
}

// ---------------------------------------------------------------------------
// Backend dispatch, extracted so the slop-repair pass can reuse it.
//
// sanitizePrompt() runs on every prompt on the way out. The context block pulls
// strings from taxonomy, products, analogs, icp and pillarShapes plus article
// bodies, doc pages and video transcripts straight out of Postgres, and those
// carried 100+ em dashes between them. Prompt style is imitated: a model shown
// that many em dashes while being told not to write them will write them.
// ---------------------------------------------------------------------------
async function runBackend(userPrompt: string): Promise<CopyOption[]> {
  const prompt = sanitizePrompt(userPrompt);
  // Prompt size is the first thing to check when the CLI hits its ceiling, so
  // it is logged rather than guessed at.
  console.log(`[generateCopy] prompt=${prompt.length} chars system=${POSITIONING_BRIEF.length} chars`);

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
        const { text, costUsd } = await runClaudeCli(POSITIONING_BRIEF, prompt + nudge);
        const options = parseOptions(text);
        if (options.length) {
          // Printed so the operator can SEE which backend served the draft.
          // costUsd is what the turn would have cost on the API; on a
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
    // The CLI could not deliver. Rather than lose the request, fall back to the
    // API when a key is configured: a draft that costs credits beats a red error
    // after a four-minute wait. Rob hit exactly this on a Smart Order Routing
    // draft, which is what surfaced the thinking-token blowup above.
    const why = lastErr instanceof Error ? lastErr.message : "CLI copy generation failed.";
    if (process.env.ANTHROPIC_API_KEY) {
      console.log(`[generateCopy] cli failed (${why}); falling back to the API backend`);
      try {
        return await runApi(prompt);
      } catch (apiErr) {
        throw new Error(`${why} API fallback also failed: ${apiErr instanceof Error ? apiErr.message : apiErr}`);
      }
    }
    throw new Error(`${why} Set ANTHROPIC_API_KEY to let the API backend cover for the CLI, or set COPY_BACKEND=api.`);
  }

  return runApi(prompt);
}

async function runApi(prompt: string): Promise<CopyOption[]> {
  const msg = await client().messages.create({
    model: MODEL,
    // 4000, not 2000. Three long-form drafts (up to 2000 chars each) plus
    // rationales, scores and citations overrun 2000 tokens, and a truncated
    // JSON array parses to zero drafts rather than to a short one.
    max_tokens: 4000,
    system: POSITIONING_BRIEF,
    messages: [{ role: "user", content: prompt }],
  });

  const textOut = msg.content.find((b) => b.type === "text");
  const options = parseOptions(textOut && textOut.type === "text" ? textOut.text : "");
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

// ---------------------------------------------------------------------------
// The enforcement half of the anti-slop standard.
//
// Rules in a prompt are followed most of the time, and "most of the time" is how
// an em dash reaches a published post. So:
//
//   1. autoFixSlop() rewrites what has one correct answer: dashes, thread
//      numbering, markdown, curly quotes. No model call, no judgment.
//   2. scanSlop() reports what is left.
//   3. If any HARD finding survives, ONE repair round-trip, quoting the findings.
//      Rare in practice because step 1 already covers the two most common ones.
//
// Whatever still fails after that rides along on the option as `slop`, so the
// operator sees the specific line instead of a vague low score.
// ---------------------------------------------------------------------------
async function polish(
  options: CopyOption[],
  analogSources: { title: string; url: string }[],
  pin?: { title: string; url: string } | null,
  recency?: RecencyContext,
  // The persisted source text. When present, every claim a draft attributes to
  // the source is matched back against it before the draft can be returned.
  sourceBody?: string | null,
): Promise<CopyOption[]> {
  // Slop and false recency are checked together and reported together. They
  // are both "the draft came back wrong in a way a regex can prove", they both
  // ride out on `slop` for the UI, and the repair pass has to see BOTH or the
  // acceptance test below rejects a good repair: a rewrite that fixes an em
  // dash while leaving "just published" in place would otherwise look like an
  // improvement and quietly take the recency finding off the screen with it.
  const scanAll = (text: string, citedUrl?: string | null): SlopFinding[] => [
    ...scanSlop(text),
    ...(recency ? scanRecency(text, recency, citedUrl) : []),
  ];

  const fixed = options.map((o) => {
    const text = autoFixSlop(o.text);
    // Grounding rides the same channel as slop for a reason: it is the same
    // kind of check (mechanical, provable, no judgment) and it must be
    // impossible for a fabricated attribution to be quieter in the UI than a
    // stray em dash. Both feed hardFindings, both feed the repair prompt.
    const verdicts = sourceBody ? verifyClaims(o.claims ?? [], sourceBody) : [];
    const grounding = sourceBody
      ? [...groundingFindings(verdicts), ...attributionFindings(text, o.claims ?? [], o.sourceTitle)]
      : [];
    return { ...o, text, claimVerdicts: verdicts, slop: [...scanAll(text, o.sourceUrl), ...grounding] };
  });

  const failing = fixed.filter((o) => hardFindings(o.slop ?? []).length > 0);
  if (!failing.length || process.env.COPY_SLOP_REPAIR === "off") {
    if (failing.length) console.log(`[generateCopy] slop repair skipped (COPY_SLOP_REPAIR=off), ${failing.length} draft(s) failing`);
    // Still filtered. COPY_SLOP_REPAIR=off turns off the REPAIR round-trip, not
    // the grounding gate — an env var must not be able to let an unsupported
    // claim through.
    return dropUngrounded(fixed);
  }

  console.log(`[generateCopy] slop repair: ${failing.length}/${fixed.length} draft(s) with hard findings`);

  const repairPrompt = [
    ANTI_SLOP_BRIEF,
    "",
    "The drafts below failed the mechanical house checks. Fix ONLY what is flagged.",
    "Keep the angle, the argument, the facts, the length band and any URL EXACTLY as they are.",
    "Do not smooth the voice, do not re-hedge a claim, do not add a closing line.",
    // Without this carve-out the repair pass is stuck: a false-recency finding
    // can only be fixed by changing the words that assert the date, and the
    // line above tells it to keep the facts as they are.
    "ONE EXCEPTION: a false-recency finding IS a fix to the words that assert a date. Remove or",
    "correct the timestamp exactly as the finding says. Do not swap in a different timestamp, do",
    "not soften it to 'recently', and change nothing else in the sentence.",
    "",
    // Second carve-out, same shape as the first. Without it the repair pass is
    // told to keep the facts exactly as they are, which is precisely what an
    // ungrounded claim cannot do.
    "SECOND EXCEPTION: an 'ungrounded-claim' finding means the source does not say that. DELETE",
    "the sentence making the claim and reflow what is left. Do NOT rescue it by hedging ('suggests',",
    "'points to', 'touches on'), do NOT swap in a different fact, and do NOT re-attribute it to",
    "someone else — a softened fabrication is still a fabrication. If deleting it leaves the post",
    "without a point, return the draft unchanged and it will be dropped instead.",
    "An 'unbacked-attribution' finding is fixed by removing the by-name credit, keeping the link.",
    "",
    // The repair call is a fresh context, so it needs the dates too or it has
    // no way to tell what a correct replacement would be.
    ...(recency ? [recencyBlock(recency) ?? "", ""] : []),
    ...failing.map((o, i) =>
      [
        `DRAFT ${i + 1}:`,
        `"""${o.text}"""`,
        `FINDINGS:`,
        findingsForRepair(o.slop ?? []),
        "",
      ].join("\n"),
    ),
    `Return STRICT JSON only, no prose, no code fences:`,
    `[{"i": <the draft number>, "text": "<the corrected draft>"}]`,
  ].join("\n");

  try {
    const repaired = await runRepair(sanitizePrompt(repairPrompt));
    for (const r of repaired) {
      const target = failing[r.i - 1];
      if (!target || !r.text) continue;
      const text = autoFixSlop(r.text);
      // Re-verify grounding against the REPAIRED text. A claim the repair
      // deleted is no longer asserted, so it is no longer checked — otherwise a
      // correctly-fixed draft would still fail on a claim it no longer makes.
      const stillClaimed = sourceBody
        ? (target.claims ?? []).filter((c) => claimStillAsserted(c.claim, text))
        : [];
      const verdicts = sourceBody ? verifyClaims(stillClaimed, sourceBody) : [];
      const grounding = sourceBody
        ? [...groundingFindings(verdicts), ...attributionFindings(text, stillClaimed, target.sourceTitle)]
        : [];
      // Only accept the repair if it actually reduced the hard findings. A
      // repair that makes it worse is worse than the draft we already had.
      const after = [...scanAll(text, target.sourceUrl), ...grounding];
      if (hardFindings(after).length < hardFindings(target.slop ?? []).length) {
        target.text = text;
        target.slop = after;
        target.claims = stillClaimed;
        target.claimVerdicts = verdicts;
      }
    }
  } catch (e) {
    // A failed repair is not a failed generation. The operator still gets the
    // drafts, with the findings attached and visible.
    console.log(`[generateCopy] slop repair failed, returning drafts with findings: ${e instanceof Error ? e.message : e}`);
  }

  // The repair may have touched a URL despite being told not to, so the citation
  // goes back through the same reconciliation the first pass used.
  return dropUngrounded(reconcileSources(fixed, analogSources, pin));
}

// The one finding class that is never merely "surfaced".
//
// Slop rides out on the option so the operator can judge it — a soft em-dash
// finding on an otherwise good draft is information, not a veto. A claim the
// source does not support is different in kind: it reads exactly like a true
// one, it is the thing that gets copied into the composer, and the whole point
// of this pass is that it must not be possible to publish. So a draft still
// carrying an ungrounded claim after its repair round-trip does not come back
// at all.
//
// Rob, on the drafts that prompted this: "i want to ensure that draft copies
// never assume information or make claims that aren't 100% factual and backed
// by the source material we're using for the post."
const GROUNDING_RULES = new Set(["ungrounded-claim", "unbacked-attribution"]);

function dropUngrounded(options: CopyOption[]): CopyOption[] {
  const kept = options.filter((o) => !hardFindings(o.slop ?? []).some((f) => GROUNDING_RULES.has(f.rule)));
  const lost = options.length - kept.length;
  if (lost) {
    console.warn(
      `[generateCopy] dropped ${lost}/${options.length} draft(s) with claims the source does not support`,
    );
  }
  // Better a clear failure than a thinner set of drafts the operator assumes
  // was everything the model produced.
  if (!kept.length && options.length) {
    throw new Error(
      `Every draft made a claim the source does not support, and none survived repair. This usually means ` +
        `the source cannot carry this concept — check that the piece actually discusses the mechanism, or ` +
        `pick a different source.`,
    );
  }
  return kept;
}

async function runRepair(prompt: string): Promise<{ i: number; text: string }[]> {
  let raw: string;
  if (chosenBackend() === "cli") {
    const { text } = await runClaudeCli("You are a precise copy editor. You return JSON and nothing else.", prompt);
    raw = text;
  } else {
    const msg = await client().messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: "You are a precise copy editor. You return JSON and nothing else.",
      messages: [{ role: "user", content: prompt }],
    });
    const t = msg.content.find((b) => b.type === "text");
    raw = t && t.type === "text" ? t.text : "";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    const m = raw.match(/\[[\s\S]*\]/);
    parsed = m ? JSON.parse(m[0]) : [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((r): r is { i: number; text: string } => !!r && typeof r === "object" && typeof (r as { text?: unknown }).text === "string")
    .map((r) => ({ i: Number(r.i), text: String(r.text).slice(0, 2400) }));
}
