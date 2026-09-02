import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { saveAngle, setAngleStatus, deleteAngle, type AngleStatus } from "@/lib/angleBank";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Broad Educational angle bank. DB writes only — no model calls, no X reads
// — so it follows /api/label's precedent and stays open while the app is
// pre-auth rather than sitting behind CRON_SECRET like the spending endpoints.

const STATUSES: AngleStatus[] = ["banked", "used", "parked"];

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // Status change: { id, status, postId? }
    if (typeof body.status === "string") {
      const id = Number(body.id);
      if (!Number.isFinite(id)) {
        return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
      }
      if (!STATUSES.includes(body.status)) {
        return NextResponse.json({ ok: false, error: `status must be one of ${STATUSES.join(", ")}` }, { status: 400 });
      }
      await setAngleStatus(sql, id, body.status, typeof body.postId === "string" ? body.postId : null);
      return NextResponse.json({ ok: true, id });
    }

    // Save (insert or update): { id?, frame, mechanism?, ecoBridge?, ... }
    if (typeof body.frame !== "string" || !body.frame.trim()) {
      return NextResponse.json(
        { ok: false, error: "frame is required — the one line you'd pitch the angle as" },
        { status: 400 },
      );
    }
    const id = await saveAngle(sql, {
      id: body.id != null ? Number(body.id) : null,
      analogId: body.analogId ?? null,
      frame: body.frame,
      mechanism: body.mechanism ?? null,
      ecoBridge: body.ecoBridge ?? null,
      icp: body.icp ?? null,
      sourceUrl: body.sourceUrl ?? null,
      sourceNote: body.sourceNote ?? null,
    });
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = Number(req.nextUrl.searchParams.get("id"));
    if (!Number.isFinite(id)) {
      return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
    }
    await deleteAngle(sql, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
