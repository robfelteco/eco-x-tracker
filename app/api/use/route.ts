import { NextRequest, NextResponse } from "next/server";
import { createUse, dismissUse } from "@/lib/recUses";
import { isTemplate } from "@/lib/taxonomy";
import { auth } from "@/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Mark as used" from the Prioritize board — records that the operator acted on
// a recommendation, so the next sync can attribute the resulting post back to
// it. Now behind Google sign-in (middleware.ts), so `used_by` records the real
// operator instead of the "public" placeholder V1 shipped with — which is what
// makes per-person attribution possible on the history shelf.
export async function POST(req: NextRequest) {
  try {
    const sessionEmail = (await auth())?.user?.email ?? null;
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
      // The session is authoritative; a `by` in the body is only a fallback for
      // callers that predate auth. Never let the client claim an identity.
      usedBy: sessionEmail ?? (typeof by === "string" && by ? by.slice(0, 120) : "public"),
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
