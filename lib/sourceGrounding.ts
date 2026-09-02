import { verifyQuote, normalizeQuote, segmentStartForQuote, type TimedSegment } from "./quoteVerify.ts";
import type { SlopFinding } from "./antiSlop.ts";

// ---------------------------------------------------------------------------
// GROUNDING — the curriculum drafter's evidence layer.
//
// The failure this exists to make impossible:
//
//   The analog registry (lib/analogs.ts) hands the drafter a complete, correct
//   TradFi thesis in `parallel` and `breaksWhere`. The source used to arrive as
//   title + URL + summary + key_facts and NOTHING ELSE. The prompt then said
//   "CREDIT IT BY NAME IN THE BODY". With no source text in context the model
//   had no way to tell whether the piece supported the thesis, so it welded the
//   analog's argument onto whichever source was pinned and attributed it.
//
//   Observed twice, on two different Tokenized episodes: three drafts each
//   arguing DNS/RTGS netting mechanics — a subject neither episode raises —
//   with lines like "the nostro/vostro prefunding problem is a capital cost,
//   not a latency one" attributed to a named Citi executive who says the
//   opposite. Both episodes' key_facts had been extracted from the YouTube
//   description, so the "checkable claims" were partly sponsor ad copy.
//
// The instruction "never assert a mechanism the source does not support" was
// already in the prompt. It could not be followed, because there was nothing to
// check against, and an unevaluable instruction is not a guardrail. So this
// module does two mechanical things instead:
//
//   1. selectWindows()  — put the RIGHT part of the source in front of the
//      model. Truncating a 55k-char transcript to its first 5k gives it the
//      first four minutes of an hour; vocabulary-matched retrieval gives it the
//      passages that actually bear on the concept, and reports honestly when
//      there are none.
//   2. verifyClaims()   — every factual claim a draft makes must ship with the
//      span it came from, and that span is matched back against the persisted
//      body by lib/quoteVerify.ts. Same gate quote_candidates already passes
//      through; the curriculum path simply never used it.
//
// Nothing here calls a model. That is deliberate: a verifier that can be
// convinced is not a verifier.
// ---------------------------------------------------------------------------

/** A passage of the source, with enough context to be argued from honestly. */
export interface SourceWindow {
  text: string;
  /** Char offset in the body, so two windows can be ordered and de-duplicated. */
  at: number;
  /** Which concept terms matched here — shown to the model so it knows why it got this. */
  hits: string[];
  /** Media timestamp when the source is diarized, for "at 22:58 she says…". */
  startSec: number | null;
}

// Windows are sentence-ish rather than fixed-width: a claim cut in half mid-
// sentence is exactly the kind of thing that gets paraphrased into something
// the source did not say.
const WINDOW_CHARS = 1400;
const WINDOW_OVERLAP = 200;

function splitWindows(body: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  let i = 0;
  while (i < body.length) {
    let end = Math.min(i + WINDOW_CHARS, body.length);
    if (end < body.length) {
      // Prefer a sentence or line boundary in the last fifth of the window.
      const tail = body.slice(end - WINDOW_CHARS / 5, end);
      const m = tail.lastIndexOf(". ");
      const nl = tail.lastIndexOf("\n");
      const cut = Math.max(m, nl);
      if (cut > 0) end = end - WINDOW_CHARS / 5 + cut + 1;
    }
    out.push({ text: body.slice(i, end).trim(), at: i });
    if (end >= body.length) break;
    i = Math.max(i + 1, end - WINDOW_OVERLAP);
  }
  return out.filter((w) => w.text.length > 80);
}

// ---------------------------------------------------------------------------
// Sponsor reads.
//
// This is not a nicety. The first bad draft cited "Fireblocks reported over
// $100 billion in monthly stablecoin volume" as though a guest had said it on
// the show; the line is from the mid-roll ad. That number reached the drafter
// through key_facts extracted from the YouTube description — but it is ALSO in
// the transcript, word for word, which means verbatim verification would have
// happily passed it. A grounded fabrication is still a fabrication: the claim
// is "the podcast reported X" and the podcast did not report X, it sold an ad.
//
// So ad blocks come out of the body BEFORE retrieval, and the passages the
// model sees are editorial content only.
//
// The markers are the formulaic top and tail of a read. Deliberately narrow:
// over-stripping loses real material, and every one of these phrases is
// vanishingly rare in actual conversation.
// ---------------------------------------------------------------------------
// Unambiguous on their own — one is enough to call a sentence an ad.
const AD_STRONG = [
  /\b(?:this|the)\s+(?:episode|series|show|segment)\s+is\s+(?:also\s+)?(?:sponsored\s+by|brought\s+to\s+you)/i,
  /\bbrought\s+to\s+you\s+(?:and\s+made\s+possible\s+)?by\b/i,
  /\bis\s+(?:also\s+)?sponsored\s+by\b/i,
  /\bthank(?:s|\s+you)?\s+(?:so\s+much\s+)?to\s+our\s+sponsors?\b/i,
  /\b(?:learn|find\s+out|read)\s+more\s+at\s+\S*[a-z0-9-]+\.(?:com|xyz|io|org)/i,
  /\bhear\s+from\s+our\s+sponsors?\b/i,
  /\bour\s+sponsors?\b.{0,40}\bappreciate\b/i,
];

// Marketing register. Individually these can appear in real speech, so one is
// not enough — but two in a sentence, or one inside a run of ad sentences, is.
const AD_WEAK = [
  /\binfrastructure\s+of\s+choice\b/i,
  /\btrusted\s+by\b/i,
  /\bpowers?\b.{0,40}\bat\s+scale\b/i,
  /\bat\s+scale\s+with\b/i,
  /\byou\s+get\s+complete\s+control\b/i,
  /\bmakes?\s+it\s+easier\s+for\s+you\s+to\b/i,
  /\bbacked\s+by\s+over\b/i,
  /\ball\s+in\s+one\s+single\b/i,
  /\bof\s+course\s+the\s+global\s+leader\b/i,
  /\b[a-z0-9-]{3,}\.(?:com|xyz|io)\/[a-z]{2,20}\b/i,
];

/** How many non-ad sentences may sit between two ad sentences and still be absorbed. */
const AD_GAP = 2;

export interface StrippedBody {
  body: string;
  /** Char count removed, for logging and for the operator's confidence. */
  removed: number;
  blocks: number;
}

/** Sentence spans, offsets preserved. */
// A scanner rather than a regex, because every character must land in exactly
// one sentence. The regex version dropped any run it could not match: with the
// terminator requiring trailing whitespace, " Learn more at fireblocks.com."
// matched nothing at its start offset, so the engine skipped forward and the
// text vanished from the sentence list entirely — never classified, and
// therefore never stripped. Silent omission is the worst failure mode here,
// since the whole point is that nothing gets past unexamined.
function sentences(body: string): { at: number; end: number; text: string }[] {
  const out: { at: number; end: number; text: string }[] = [];
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    const isTerm = c === "." || c === "!" || c === "?";
    const isBreak = c === "\n";
    if (!isTerm && !isBreak) continue;
    if (isTerm) {
      // Run past "?!" and "...", then require whitespace or end — so a period
      // inside "fireblocks.com" or "T+1." does not end the sentence.
      let j = i;
      while (j + 1 < body.length && ".!?".includes(body[j + 1])) j++;
      const next = body[j + 1];
      if (next !== undefined && !/\s/.test(next)) continue;
      i = j;
    }
    if (body.slice(start, i + 1).trim()) out.push({ at: start, end: i + 1, text: body.slice(start, i + 1) });
    start = i + 1;
  }
  if (body.slice(start).trim()) out.push({ at: start, end: body.length, text: body.slice(start) });
  return out;
}

/**
 * Blank out sponsor reads, preserving offsets so timestamps and match indexes
 * stay meaningful. Replaced with spaces rather than deleted for exactly that
 * reason — a body whose offsets shift no longer lines up with `segments`.
 *
 * Sentence-level, NOT a char range from an opener. The first version of this
 * ran a fixed window forward from "brought to you by" and swallowed 2,884
 * characters of the Citi episode — taking "we're a corresponding bank for 1,500
 * different banks" and "this time last year we were processing millions, now
 * we're processing billions" with it. Over-stripping is not a safe failure: it
 * makes TRUE claims unverifiable, which trains the operator to distrust the
 * gate. So each sentence is judged on its own, and only a contiguous run of
 * promotional sentences is removed.
 */
export function stripSponsorReads(body: string): StrippedBody {
  const sents = sentences(body);
  if (!sents.length) return { body, removed: 0, blocks: 0 };

  const weak = sents.map((s) => AD_WEAK.filter((re) => re.test(s.text)).length);
  const isAd = sents.map((s, i) => AD_STRONG.some((re) => re.test(s.text)) || weak[i] >= 2);

  // Absorb the middle of a read: an ad's body is plain marketing prose that may
  // trip no single rule, but it sits between the "sponsored by" opener and the
  // "learn more at" close.
  for (let i = 0; i < isAd.length; i++) {
    if (!isAd[i]) continue;
    for (let j = i + 1; j <= Math.min(i + AD_GAP + 1, isAd.length - 1); j++) {
      if (isAd[j]) {
        for (let k = i + 1; k < j; k++) isAd[k] = true;
        break;
      }
    }
  }

  // Extend a run outward over sentences carrying ONE weak signal. A lone
  // "you get complete control" is ordinary enough to keep in isolation; sitting
  // against a confirmed ad sentence it is the same read continuing. This is
  // what catches the tail after the last strong marker — the stretch between
  // "...manage stablecoins" and "Learn more at fireblocks.com".
  for (let pass = 0; pass < 6; pass++) {
    let grew = false;
    for (let i = 0; i < isAd.length; i++) {
      if (isAd[i] || weak[i] < 1) continue;
      if (isAd[i - 1] || isAd[i + 1]) {
        isAd[i] = true;
        grew = true;
      }
    }
    if (!grew) break;
  }

  const chars = body.split("");
  let removed = 0;
  let blocks = 0;
  let prev = false;
  for (let i = 0; i < sents.length; i++) {
    if (!isAd[i]) {
      prev = false;
      continue;
    }
    if (!prev) blocks++;
    prev = true;
    for (let k = sents[i].at; k < sents[i].end; k++) {
      if (chars[k] !== "\n") {
        chars[k] = " ";
        removed++;
      }
    }
  }
  return { body: chars.join(""), removed, blocks };
}

/**
 * Retrieve the passages of `body` that bear on a concept, ranked by how much of
 * its vocabulary they carry.
 *
 * `vocab` is the analog's own term list from lib/analogs.ts — the same strings
 * the concept is defined by, so a source that never uses any of them is, on the
 * evidence, not a source about this concept. That is a fact worth surfacing
 * rather than papering over: see `sourceCarriesConcept`.
 */
export function selectWindows(
  body: string,
  vocab: string[],
  opts: { budgetChars?: number; segments?: TimedSegment[] | null } = {},
): SourceWindow[] {
  const budget = opts.budgetChars ?? 7000;
  const terms = vocab.map((v) => v.toLowerCase()).filter(Boolean);
  if (!body.trim()) return [];

  // Editorial content only. See stripSponsorReads: an ad read is verbatim in
  // the transcript, so verification alone would not catch a draft citing one.
  const stripped = stripSponsorReads(body);
  if (stripped.blocks) {
    console.log(
      `[grounding] removed ${stripped.blocks} sponsor read(s), ${stripped.removed} chars, before retrieval`,
    );
  }

  const scored = splitWindows(stripped.body).map((w) => {
    const hay = w.text.toLowerCase();
    const hits = terms.filter((t) => hay.includes(t));
    return { ...w, hits, score: hits.length };
  });

  const matched = scored.filter((w) => w.score > 0).sort((a, b) => b.score - a.score || a.at - b.at);

  // No vocabulary anywhere in the piece. Hand back the opening so the caller can
  // still SHOW the operator what the source is, but `sourceCarriesConcept` will
  // be false and the drafter is gated off it upstream.
  const picked = matched.length ? matched : scored.slice(0, 2).map((w) => ({ ...w, hits: [] as string[], score: 0 }));

  const out: SourceWindow[] = [];
  let spent = 0;
  for (const w of picked) {
    if (spent + w.text.length > budget) continue;
    out.push({
      text: w.text,
      at: w.at,
      hits: w.hits,
      startSec: opts.segments?.length ? segmentStartForQuote(w.text.slice(0, 120), opts.segments) : null,
    });
    spent += w.text.length;
    if (spent >= budget) break;
  }
  // Reading order, not relevance order: a transcript read out of sequence
  // invites the model to stitch two unrelated moments into one argument.
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Does this source actually discuss this concept?
 *
 * Cheap, mechanical, and deliberately conservative. It answers the question the
 * netting drafts got wrong: the episode was a real, verified, on-topic payments
 * podcast — it simply never mentioned netting, and nothing in the pipeline was
 * in a position to notice.
 */
export function sourceCarriesConcept(windows: SourceWindow[]): boolean {
  return windows.some((w) => w.hits.length > 0);
}

// ---------------------------------------------------------------------------
// Claim verification.
// ---------------------------------------------------------------------------

/** What a draft must return alongside its text: every factual assertion, with its span. */
export interface DraftClaim {
  /** The assertion as it appears in the post. */
  claim: string;
  /** The span of the source it rests on, copied verbatim. */
  sourceQuote: string;
}

export interface ClaimVerdict extends DraftClaim {
  verification: "exact" | "fuzzy" | "failed";
  similarity: number;
  /** Where it matched, for showing the operator real surrounding text. */
  matchIndex: number | null;
}

/**
 * Match every claim's cited span back against the persisted source body.
 *
 * Reuses lib/quoteVerify.ts unchanged — it already does normalized token
 * windowing at a 0.95 threshold and was written for precisely this reason
 * ("a hallucinated quote attributed to a named executive is a brand incident,
 * not a bug"). The curriculum path is simply the second consumer.
 */
export function verifyClaims(claims: DraftClaim[], body: string): ClaimVerdict[] {
  // Verified against the SAME text the model was shown — editorial only. If
  // retrieval strips ad reads but verification does not, a draft can still cite
  // the mid-roll (from key_facts, or from the model's own memory of the show)
  // and pass, because the ad really is in the transcript. Offsets are preserved
  // by the strip, so matchIndex stays meaningful.
  const editorial = stripSponsorReads(body).body;
  return claims.map((c) => {
    const r = verifyQuote(c.sourceQuote ?? "", editorial);
    return { ...c, verification: r.verification, similarity: r.similarity, matchIndex: r.matchIndex };
  });
}

/**
 * Grounding failures, shaped as SlopFindings so they ride the machinery that
 * already exists: `hardFindings` gates them, `findingsForRepair` renders them
 * into the repair prompt, and the UI surfaces them on the draft. No new
 * plumbing, and no way for a grounding failure to be quieter than an em dash.
 */
export function groundingFindings(verdicts: ClaimVerdict[]): SlopFinding[] {
  const out: SlopFinding[] = [];
  for (const v of verdicts) {
    if (v.verification === "failed") {
      out.push({
        rule: "ungrounded-claim",
        severity: "hard",
        match: v.claim.slice(0, 160),
        fix:
          `This claim cites "${(v.sourceQuote ?? "").slice(0, 90)}" but no such passage exists in the source ` +
          `(best match ${(v.similarity * 100).toFixed(0)}%). Delete the claim, or replace it with one the ` +
          `source text actually states. Do not reword it to sound hedged — remove it.`,
      });
    } else if (v.verification === "fuzzy" && v.similarity < 0.98) {
      out.push({
        rule: "loose-paraphrase",
        severity: "soft",
        match: v.claim.slice(0, 160),
        fix: `Cited span matched at ${(v.similarity * 100).toFixed(0)}%. Tighten the claim to what the source literally says.`,
      });
    }
  }
  return out;
}

/**
 * Is this claim still being asserted by the post?
 *
 * The repair pass fixes a grounding failure by DELETING the offending sentence,
 * and it returns only the corrected text — not a fresh claims array. So after a
 * repair, a claim that no longer appears in the post is no longer a claim, and
 * re-verifying it would reject a draft that was correctly fixed.
 *
 * Token-overlap rather than substring, because the repair is allowed to reflow
 * the sentence around the deletion.
 */
export function claimStillAsserted(claim: string, text: string): boolean {
  const c = normalizeQuote(claim).split(" ").filter((w) => w.length > 3);
  if (!c.length) return false;
  const hay = normalizeQuote(text);
  const present = c.filter((w) => hay.includes(w)).length;
  return present / c.length >= 0.7;
}

/**
 * A draft that makes zero verifiable claims but credits a source by name is the
 * exact shape of the bug: the argument came from the analog registry and the
 * citation was bolted on. Flagged hard.
 */
export function attributionFindings(text: string, claims: DraftClaim[], sourceTitle?: string | null): SlopFinding[] {
  if (!sourceTitle) return [];
  const creditsSource = claims.length === 0;
  if (!creditsSource) return [];
  return [
    {
      rule: "unbacked-attribution",
      severity: "hard",
      match: sourceTitle.slice(0, 160),
      fix:
        `The draft credits this source but returned no claims resting on it, so nothing ties the argument ` +
        `to the piece. Either build the post on a specific passage from the source and cite it, or drop the ` +
        `by-name credit and let the link stand alone.`,
    },
  ];
}
