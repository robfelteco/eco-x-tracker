import { NextRequest, NextResponse } from "next/server";
import { runRuleClassification, runClaudeClassification } from "@/lib/classify";
import { enrichUnenriched } from "@/lib/enrich";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Money-spending endpoint (Anthropic credits). Locked to cron / CRON_SECRET.
function authorized(req: NextRequest): boolean {
  if (req.headers.get("x-vercel-cron")) return true;
  const secret = process.env.CRON_SECRET;
  return !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
}

// POST /api/classify?mode=rules   → Stage-1 deterministic pass.
// POST /api/classify?mode=claude   → Stage-2 Claude multimodal pass (?limit=N).
// POST /api/classify?mode=enrich   → backfill link-preview cards (?limit=N).
export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const mode = req.nextUrl.searchParams.get("mode") ?? "rules";
  const all = req.nextUrl.searchParams.get("all") === "1";
  try {
    if (mode === "rules") {
      const result = await runRuleClassification(all); // all=1 → reset+re-run rules
      return NextResponse.json({ ok: true, mode, ...result });
    }
    if (mode === "claude") {
      const limitParam = req.nextUrl.searchParams.get("limit");
      const limit = limitParam ? Math.max(1, Math.min(2000, Number(limitParam))) : undefined;
      const result = await runClaudeClassification(limit);
      return NextResponse.json({ ok: true, mode, ...result });
    }
    if (mode === "enrich") {
      // Backfill link-preview cards (resolve t.co + scrape OG) for stored posts.
      const limitParam = req.nextUrl.searchParams.get("limit");
      const limit = limitParam ? Math.max(1, Math.min(2000, Number(limitParam))) : 200;
      const result = await enrichUnenriched(limit);
      return NextResponse.json({ ok: true, mode, ...result });
    }
    return NextResponse.json({ ok: false, error: `Unknown mode: ${mode}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
