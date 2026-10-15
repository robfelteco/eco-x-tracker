import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { getLaneRegistry, reviewLane, type LaneKind, type LaneReviewAction } from "@/lib/laneRegistry";
import { retagAll } from "@/lib/laneDetect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const KINDS: LaneKind[] = ["chain", "product", "partner"];
const ACTIONS: LaneReviewAction[] = ["confirm", "rename", "merge", "dismiss"];

// Review one auto-detected lane (Migration 019).
//
// Three of the four actions change what a post is tagged with — dismissing a
// lane has to take its tags off the posts, merging has to move them — so every
// action except a plain confirm re-tags the corpus before returning. That is a
// few hundred rows and it is the difference between the tray doing what it says
// and the operator dismissing a lane that then stays on screen.
export async function POST(req: NextRequest) {
  try {
    const { kind, id, action, value } = await req.json();
    if (!KINDS.includes(kind)) {
      return NextResponse.json({ ok: false, error: `kind must be one of ${KINDS.join(", ")}` }, { status: 400 });
    }
    if (typeof id !== "string" || !id) {
      return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
    }
    if (!ACTIONS.includes(action)) {
      return NextResponse.json({ ok: false, error: `action must be one of ${ACTIONS.join(", ")}` }, { status: 400 });
    }
    if ((action === "rename" || action === "merge") && (typeof value !== "string" || !value.trim())) {
      return NextResponse.json({ ok: false, error: `${action} needs a value` }, { status: 400 });
    }

    await reviewLane(sql, kind, id, action, typeof value === "string" ? value.trim() : undefined);

    let retagged = 0;
    if (action !== "confirm" && action !== "rename") {
      retagged = await retagAll(sql, await getLaneRegistry(sql));
    }
    return NextResponse.json({ ok: true, retagged });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
