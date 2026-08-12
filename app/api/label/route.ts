import { NextRequest, NextResponse } from "next/server";
import { applyHumanLabel } from "@/lib/classify";
import { isTemplate } from "@/lib/taxonomy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Human correction from the review queue. Open to any viewer in V1 (edit actions
// are intentionally open while the app is public and pre-auth). Labeling only
// writes to our DB — no external cost — so it's safe to leave open; it tightens
// once @eco.com Google auth is added.
export async function POST(req: NextRequest) {
  try {
    const { postId, template, by } = await req.json();
    if (typeof postId !== "string" || !isTemplate(template)) {
      return NextResponse.json({ ok: false, error: "postId and a valid template are required" }, { status: 400 });
    }
    const labeledBy = typeof by === "string" && by ? by.slice(0, 120) : "public";
    const ok = await applyHumanLabel(postId, template, labeledBy);
    return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
