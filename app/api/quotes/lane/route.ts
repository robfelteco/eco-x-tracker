import { NextRequest, NextResponse } from "next/server";
import { runLane, LANES, type Lane } from "@/lib/quoteDiscovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Run ONE lane of a discovery run. The client calls this per lane so each stays
// inside the function duration limit and partial results land as they finish.
export async function POST(req: NextRequest) {
  try {
    const { runId, lane } = await req.json();
    if (!Number.isFinite(runId)) {
      return NextResponse.json({ ok: false, error: "runId is required" }, { status: 400 });
    }
    if (!LANES.includes(lane)) {
      return NextResponse.json({ ok: false, error: `lane must be one of ${LANES.join(", ")}` }, { status: 400 });
    }
    const outcome = await runLane(Number(runId), lane as Lane);
    return NextResponse.json({ ok: true, outcome });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
