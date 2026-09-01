import { NextRequest, NextResponse } from "next/server";
import { generateCopy } from "@/lib/generateCopy";
import { isTemplate } from "@/lib/taxonomy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Postgres bigint comes back from the driver as a STRING, not a number — the
// driver has no way to know the value is inside JS's safe integer range, so it
// refuses to guess. Every id on the shelves (articles, doc_pages, videos) is a
// bigint identity, so they all arrive here as "30" rather than 30.
//
// The old check was Number.isFinite(articleId), which is false for a string.
// So every article-, docs- and video-backed draft silently lost its source and
// fell through to the pillar-only prompt — the drafter then invented facts that
// were plausible but appeared in no piece we published. It only became visible
// when the chain pillar started failing loudly instead of drafting unsourced.
//
// Coerce rather than validate, and reject only what genuinely is not an id.
function toId(v: unknown): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v > 0 ? v : null;
  if (typeof v === "string" && /^\d+$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

// Draft starting-point copy for one recommendation. Spends Anthropic credits, so
// it only runs on an explicit click (never on page load). Left open in V1 like
// the other write endpoints; tightens once @eco.com auth lands.
export async function POST(req: NextRequest) {
  try {
    const { template, chain, product, articleId, docPageId, videoId, analogId, sourceId, eduShape, shape, angle, basePostText, priorTexts } =
      await req.json();
    if (!isTemplate(template)) {
      return NextResponse.json({ ok: false, error: "a valid template is required" }, { status: 400 });
    }
    const options = await generateCopy({
      template,
      chain: typeof chain === "string" && chain ? chain : null,
      product: typeof product === "string" && product ? product : null,
      articleId: toId(articleId),
      docPageId: toId(docPageId),
      videoId: toId(videoId),
      analogId: typeof analogId === "string" && analogId ? analogId : null,
      // One source per call. The concept-level fan-out is N of these requests,
      // issued by the client so each source's drafts land as they finish and one
      // failing source cannot take down the whole click. Server-side fan-out
      // would also put N sequential model calls inside a single 60s function.
      sourceId: toId(sourceId),
      eduShape: typeof eduShape === "string" && eduShape ? eduShape : null,
      shape: typeof shape === "string" && shape ? shape : null,
      angle: typeof angle === "string" && angle ? angle.slice(0, 500) : null,
      basePostText: typeof basePostText === "string" && basePostText ? basePostText : null,
      // The posts that already used this article. Handed to the drafter as
      // "these angles are spent" so iteration N+1 isn't a near-duplicate of 1..N.
      priorTexts: Array.isArray(priorTexts) ? priorTexts.filter((t) => typeof t === "string").slice(0, 6) : [],
    });
    return NextResponse.json({ ok: true, options }, { status: 200 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
