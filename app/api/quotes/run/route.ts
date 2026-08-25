import { NextRequest, NextResponse } from "next/server";
import { createRun, RunInProgressError } from "@/lib/quoteDiscovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Enqueue a discovery run and return immediately (spec §3.1). The lanes are
// driven separately by /api/quotes/lane — a Gemini pass over a 90-minute podcast
// takes minutes and no single serverless invocation should be holding that open.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const lookbackDays = Number.isFinite(body?.lookbackDays) ? Math.max(1, Math.min(365, body.lookbackDays)) : 365;
    const budgetCents = Number.isFinite(body?.budgetCents) ? Math.max(50, Math.min(5000, body.budgetCents)) : 500;
    const runId = await createRun({ triggeredBy: "ui", lookbackDays, budgetCents });
    return NextResponse.json({ ok: true, runId, lookbackDays, budgetCents });
  } catch (err) {
    // A run already in flight is a normal condition, not a failure — hand the
    // client the existing run id so it attaches to it instead of starting a
    // second paid pass.
    if (err instanceof RunInProgressError) {
      return NextResponse.json({ ok: false, runId: err.runId, inProgress: true, error: err.message }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
