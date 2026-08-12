import { NextRequest, NextResponse } from "next/server";
import { runSync } from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Money-spending endpoint (X + Anthropic credits). While the app is public,
// this stays locked to Vercel Cron or a Bearer CRON_SECRET — never open.
function authorized(req: NextRequest): boolean {
  if (req.headers.get("x-vercel-cron")) return true;
  const secret = process.env.CRON_SECRET;
  return !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
}

async function handle(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const backfill = req.nextUrl.searchParams.get("backfill") === "1";
  const countParam = req.nextUrl.searchParams.get("count");
  const count = countParam ? Math.max(1, Math.min(3200, Number(countParam))) : undefined;
  const trigger = req.headers.get("x-vercel-cron") ? "cron" : "manual";
  try {
    const result = await runSync({ trigger, backfill, count });
    return NextResponse.json(result, { status: result.ok ? 200 : 207 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

// GET so Vercel Cron can hit it; POST for the manual "Refresh now" button.
export const GET = handle;
export const POST = handle;
