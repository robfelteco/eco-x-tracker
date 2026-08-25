import { NextRequest, NextResponse } from "next/server";
import { reviewCandidate } from "@/lib/quoteDiscovery";
import { REJECT_REASONS } from "@/lib/quoteScore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Approve or reject one candidate. Reject reasons are an ENUM, not free text —
// this data is the input to rubric tuning and is worthless as prose (spec §11).
export async function POST(req: NextRequest) {
  try {
    const { id, action, reason, by } = await req.json();
    if (!Number.isFinite(id)) return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
    if (action !== "approve" && action !== "reject") {
      return NextResponse.json({ ok: false, error: "action must be approve or reject" }, { status: 400 });
    }
    if (action === "reject" && reason && !(REJECT_REASONS as readonly string[]).includes(reason)) {
      return NextResponse.json({ ok: false, error: `reason must be one of ${REJECT_REASONS.join(", ")}` }, { status: 400 });
    }
    const done = await reviewCandidate(Number(id), action, typeof by === "string" ? by : "public", reason);
    return NextResponse.json({ ok: done, error: done ? undefined : "already reviewed" });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
