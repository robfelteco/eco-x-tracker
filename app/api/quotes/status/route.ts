import { NextRequest, NextResponse } from "next/server";
import { getRun, latestRun, getQueue, queueCounts, laneEtaMs } from "@/lib/quoteDiscovery";
import { rosterCounts } from "@/lib/quoteRoster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Poll target for the Discover panel. Returns the run's per-lane status, the
// live queue, and roster health, so the UI can show per-source coverage rather
// than one undifferentiated result list (spec §2.1).
export async function GET(req: NextRequest) {
  try {
    const idParam = req.nextUrl.searchParams.get("runId");
    const run = idParam ? await getRun(Number(idParam)) : await latestRun();
    const [queue, counts, roster, eta] = await Promise.all([
      getQueue(30),
      queueCounts(),
      rosterCounts(),
      laneEtaMs(),
    ]);
    // `eta` is per-lane median wall-clock from recent runs — the panel needs it
    // to weight the progress bar and to put a number on "how much longer".
    return NextResponse.json({ ok: true, run, queue, counts, roster, eta });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
