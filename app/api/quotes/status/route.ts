import { NextRequest, NextResponse } from "next/server";
import { getRun, latestRun, getQueue, queueCounts } from "@/lib/quoteDiscovery";
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
    const [queue, counts, roster] = await Promise.all([getQueue(30), queueCounts(), rosterCounts()]);
    return NextResponse.json({ ok: true, run, queue, counts, roster });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
