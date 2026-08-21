import { NextRequest, NextResponse } from "next/server";
import { createUse, dismissUse } from "@/lib/recUses";
import { isTemplate } from "@/lib/taxonomy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Mark as used" from the Prioritize board — records that the operator acted on
// a recommendation, so the next sync can attribute the resulting post back to
// it. Writes only to our DB (no external cost), so it's safe to leave open in
// V1 like the label route; tightens once @eco.com auth lands.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { template, chain, angle, scoreAtUse, suggestedPostId, by } = body;
    if (!isTemplate(template)) {
      return NextResponse.json({ ok: false, error: "a valid template is required" }, { status: 400 });
    }
    const id = await createUse({
      template,
      chain: typeof chain === "string" && chain ? chain : null,
      angle: typeof angle === "string" && angle ? angle.slice(0, 500) : null,
      scoreAtUse: typeof scoreAtUse === "number" ? Math.round(scoreAtUse) : null,
      suggestedPostId: typeof suggestedPostId === "string" && suggestedPostId ? suggestedPostId : null,
      usedBy: typeof by === "string" && by ? by.slice(0, 120) : "public",
    });
    return NextResponse.json({ ok: true, id }, { status: 200 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

// Undo a mistaken "mark as used" (only while still open/unmatched).
export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json();
    if (typeof id !== "number") {
      return NextResponse.json({ ok: false, error: "numeric id required" }, { status: 400 });
    }
    const ok = await dismissUse(id);
    return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
