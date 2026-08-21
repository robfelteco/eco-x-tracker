import { NextRequest, NextResponse } from "next/server";
import { runSync } from "@/lib/ingest";
import { runRuleClassification, runClaudeClassification } from "@/lib/classify";
import { attributeUses } from "@/lib/recUses";

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

    // Classify newly-ingested posts so they arrive pre-classified (spec). Rules
    // first (free), then Claude for the handful the rules can't settle. Wrapped
    // so a classification hiccup never fails the sync itself.
    let ruleSettled = 0;
    let claudeClassified = 0;
    const classifyErrors: string[] = [];
    try {
      ruleSettled = (await runRuleClassification(false)).settled;
      const c = await runClaudeClassification(200);
      claudeClassified = c.classified;
      classifyErrors.push(...c.errors);
    } catch (err) {
      classifyErrors.push(err instanceof Error ? err.message.slice(0, 200) : String(err));
    }

    // Close the recursion loop: tie any open "marked as used" recommendations to
    // the @eco posts that fulfilled them (newly-classified above). Best-effort —
    // never fails the sync.
    let attributed = 0;
    try {
      attributed = await attributeUses();
    } catch (err) {
      classifyErrors.push(err instanceof Error ? err.message.slice(0, 200) : String(err));
    }

    return NextResponse.json(
      { ...result, classified: { ruleSettled, claudeClassified, errors: classifyErrors }, attributed },
      { status: result.ok ? 200 : 207 },
    );
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
