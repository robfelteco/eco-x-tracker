import { NextRequest, NextResponse } from "next/server";
import { generateCopy } from "@/lib/generateCopy";
import { isTemplate } from "@/lib/taxonomy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Draft starting-point copy for one recommendation. Spends Anthropic credits, so
// it only runs on an explicit click (never on page load). Left open in V1 like
// the other write endpoints; tightens once @eco.com auth lands.
export async function POST(req: NextRequest) {
  try {
    const { template, chain, angle, basePostText } = await req.json();
    if (!isTemplate(template)) {
      return NextResponse.json({ ok: false, error: "a valid template is required" }, { status: 400 });
    }
    const options = await generateCopy({
      template,
      chain: typeof chain === "string" && chain ? chain : null,
      angle: typeof angle === "string" && angle ? angle.slice(0, 500) : null,
      basePostText: typeof basePostText === "string" && basePostText ? basePostText : null,
    });
    return NextResponse.json({ ok: true, options }, { status: 200 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
