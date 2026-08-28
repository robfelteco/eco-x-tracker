import { NextRequest, NextResponse } from "next/server";
import { getSourcesFor } from "@/lib/analogSources";
import { sweepConcept } from "@/lib/analogSweep";
import { ANALOG_BY_ID } from "@/lib/analogs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// GET  — what verified source material a concept already has.
// POST — sweep for more, right now.
//
// The POST runs the SAME sweep the daily cron runs (lib/analogSweep), rather
// than a separate on-demand search. One code path means the button and the cron
// cannot drift apart: same authority ranking, same keep/reject gate, same
// canonical/current tiering, same spend accounting. It also means clicking the
// button advances that concept's rotation slot, so the cron won't redo work the
// operator just did.
//
// Spends Firecrawl credits (about 9-13 per concept) plus one Claude extraction
// call, so it only runs on an explicit click.

export async function GET(req: NextRequest) {
  const analogId = req.nextUrl.searchParams.get("analogId") ?? "";
  if (!ANALOG_BY_ID[analogId]) {
    return NextResponse.json({ ok: false, error: "a valid analogId is required" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, sources: await getSourcesFor(analogId) }, { status: 200 });
}

export async function POST(req: NextRequest) {
  try {
    const { analogId } = await req.json();
    if (typeof analogId !== "string" || !ANALOG_BY_ID[analogId]) {
      return NextResponse.json({ ok: false, error: "a valid analogId is required" }, { status: 400 });
    }
    // Leave headroom inside the 300s ceiling so a slow scrape can't take the
    // whole response down with it.
    const r = await sweepConcept(analogId, { maxScrapes: 4, deadline: Date.now() + 240_000 });
    return NextResponse.json(
      {
        ok: true,
        added: r.added,
        rejected: r.rejected,
        scanned: r.scanned,
        credits: r.credits,
        partial: r.partial,
        warnings: r.warnings.slice(0, 8),
        sources: await getSourcesFor(analogId),
      },
      { status: 200 },
    );
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
