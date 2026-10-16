import { NextRequest, NextResponse } from "next/server";
import {
  getEduPipeline,
  updateEduCandidate,
  setEduCandidateStatus,
  saveEduDrafts,
  CANDIDATE_STATUSES,
  type CandidateStatus,
} from "@/lib/eduIntake";
import type { CopyOption } from "@/lib/generateCopy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Broad Educational pipeline's mutations. DB writes only, no model calls
// and no X reads, so like /api/angles and /api/label it sits behind the app's
// Google sign-in (proxy.ts) and nothing more.
//
// One route, an `action` discriminator, because every action is a one-row
// UPDATE and the client component wants one fetch helper:
//   { action: "status", id, status, postId? }   pick / skip / unpick / mark posted
//   { action: "edit",   id, frame?, mechanism?, ecoBridge?, evidence?, audience?, analogId? }
//   { action: "drafts", id, drafts }             persist what /api/generate returned
// GET returns the board, for a client refresh after an action.

export async function GET() {
  try {
    return NextResponse.json({ ok: true, pipeline: await getEduPipeline() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const id = Number(body.id);
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
    }

    if (body.action === "status") {
      if (!CANDIDATE_STATUSES.includes(body.status)) {
        return NextResponse.json({ ok: false, error: `status must be one of ${CANDIDATE_STATUSES.join(", ")}` }, { status: 400 });
      }
      await setEduCandidateStatus(id, body.status as CandidateStatus, typeof body.postId === "string" ? body.postId : null);
      return NextResponse.json({ ok: true, id });
    }

    if (body.action === "edit") {
      const str = (k: string) => (k in body ? (body[k] == null ? null : String(body[k])) : undefined);
      await updateEduCandidate(id, {
        frame: str("frame"),
        mechanism: str("mechanism"),
        ecoBridge: str("ecoBridge"),
        evidence: str("evidence"),
        audience: str("audience"),
        analogId: str("analogId"),
      });
      return NextResponse.json({ ok: true, id });
    }

    if (body.action === "drafts") {
      const drafts = Array.isArray(body.drafts)
        ? (body.drafts as unknown[]).filter((d): d is CopyOption => !!d && typeof d === "object" && typeof (d as CopyOption).text === "string")
        : [];
      if (!drafts.length) return NextResponse.json({ ok: false, error: "drafts is empty" }, { status: 400 });
      await saveEduDrafts(id, drafts);
      return NextResponse.json({ ok: true, id });
    }

    return NextResponse.json({ ok: false, error: "action must be status, edit or drafts" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
