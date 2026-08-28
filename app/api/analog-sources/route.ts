import { NextRequest, NextResponse } from "next/server";
import { findSourcesFor, getSourcesFor } from "@/lib/analogSources";
import { ANALOG_BY_ID } from "@/lib/analogs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// GET  — what verified source material a concept already has.
// POST — go find more (Grok web search, every URL checked before it is stored).
//
// The POST spends xAI credits and does a round of HTTP verification, so it only
// runs on an explicit click.

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
    const { added, rejected, sources, warnings } = await findSourcesFor(analogId);
    return NextResponse.json({ ok: true, added, rejected, sources, warnings }, { status: 200 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
