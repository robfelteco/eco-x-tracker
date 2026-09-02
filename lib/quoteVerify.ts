import { createHash } from "node:crypto";

// Verbatim verification — spec §9, and the single non-negotiable gate in the
// pipeline. A hallucinated or paraphrased quote attributed to a named executive
// is a brand incident, not a bug, so nothing reaches the review queue without
// being matched back against the persisted source text.

export function normalizeQuote(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Dedupe key. A quote reviewed and rejected once must never resurface, across
// runs and across sources — the unique index on quote_candidates.quote_hash is
// what enforces that, and this is the key it indexes.
export function quoteHash(s: string): string {
  return createHash("sha256").update(normalizeQuote(s)).digest("hex");
}

export type Verification = "exact" | "fuzzy" | "failed";

export interface VerifyResult {
  verification: Verification;
  similarity: number;
  // Where in the normalized body it matched, so the reviewer can be shown real
  // surrounding text rather than whatever the extractor claimed it was.
  matchIndex: number | null;
}

// Token-level similarity of `quote` against the best-matching window of `body`.
// A sliding window of the quote's own length; step is a fraction of that so a
// long transcript stays cheap.
function bestWindowSimilarity(quoteTokens: string[], bodyTokens: string[]): { sim: number; at: number } {
  const n = quoteTokens.length;
  if (!n || bodyTokens.length < n) return { sim: 0, at: -1 };
  const want = new Map<string, number>();
  for (const t of quoteTokens) want.set(t, (want.get(t) ?? 0) + 1);

  let best = 0;
  let bestAt = -1;
  const step = Math.max(1, Math.floor(n / 4));
  for (let i = 0; i + n <= bodyTokens.length; i += step) {
    const have = new Map<string, number>();
    for (let j = i; j < i + n; j++) {
      const t = bodyTokens[j];
      have.set(t, (have.get(t) ?? 0) + 1);
    }
    let shared = 0;
    for (const [t, c] of want) shared += Math.min(c, have.get(t) ?? 0);
    const sim = shared / n;
    if (sim > best) {
      best = sim;
      bestAt = i;
      if (sim === 1) break;
    }
  }
  return { sim: best, at: bestAt };
}

export const FUZZY_THRESHOLD = 0.95;

export function verifyQuote(quote: string, body: string): VerifyResult {
  const nq = normalizeQuote(quote);
  const nb = normalizeQuote(body);
  if (!nq) return { verification: "failed", similarity: 0, matchIndex: null };

  const idx = nb.indexOf(nq);
  if (idx !== -1) return { verification: "exact", similarity: 1, matchIndex: idx };

  const { sim, at } = bestWindowSimilarity(nq.split(" "), nb.split(" "));
  if (sim >= FUZZY_THRESHOLD) return { verification: "fuzzy", similarity: sim, matchIndex: at };
  return { verification: "failed", similarity: sim, matchIndex: null };
}

// Pull real surrounding text out of the SOURCE, rather than trusting whatever
// the extractor reported as context. Out-of-context quoting is exactly what the
// reviewer is checking for, so the context has to be independently sourced.
export function surroundingContext(
  quote: string,
  body: string,
  chars = 220,
): { before: string; after: string } {
  const hay = body.toLowerCase();
  const needle = quote.toLowerCase().slice(0, 60);
  let i = hay.indexOf(needle);
  if (i === -1) {
    // Fall back to the first distinctive run of words from the quote.
    const words = quote.split(/\s+/).slice(0, 6).join(" ").toLowerCase();
    i = hay.indexOf(words);
  }
  if (i === -1) return { before: "", after: "" };
  const end = i + quote.length;
  return {
    before: body.slice(Math.max(0, i - chars), i).trim(),
    after: body.slice(end, end + chars).trim(),
  };
}

// ---------------------------------------------------------------------------
// Which moment did this quote come from?
//
// Pass 2 extracts quotes from TEXT, and segmentsToBody() renders a transcript as
// "Speaker: text" lines with no timestamps in them. So RawCandidate.start_sec has
// nothing to be derived from and comes back 0, which youtubeDeepLink() turns into
// `&t=0` — every YouTube quote card linking to the top of a 47-minute episode
// instead of the moment. The rescale and clamp work in transcribeVideo() exist to
// make that link land correctly and were never reaching it.
//
// Recovering it needs no prompt change and no second model call: the verbatim
// gate has already established that the quote appears in the body, so the
// SEGMENT carrying it can be found the same way and its start_sec used directly.
// ---------------------------------------------------------------------------

export interface TimedSegment {
  start_sec: number;
  text: string;
}

/** Start time of the segment a quote came from, or null when it cannot be placed. */
export function segmentStartForQuote(quote: string, segments: TimedSegment[]): number | null {
  if (!segments.length) return null;
  const nq = normalizeQuote(quote);
  if (!nq) return null;

  // Whole quote inside one segment — the common case.
  for (const s of segments) {
    if (normalizeQuote(s.text).includes(nq)) return s.start_sec;
  }

  // A quote can span a speaker turn or a segment boundary. Anchor on where it
  // STARTS, which is the moment a reviewer wants the link to open at.
  const head = nq.slice(0, 40);
  if (head.length >= 12) {
    for (const s of segments) {
      if (normalizeQuote(s.text).includes(head)) return s.start_sec;
    }
  }

  // Never guess. A null leaves the plain video URL, which is honest; a wrong
  // offset sends the reviewer to the wrong part of the episode.
  return null;
}
