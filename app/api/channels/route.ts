import { NextRequest, NextResponse } from "next/server";
import { runChannelSweep } from "@/lib/channelSweep";
import { promoteDescriptionSources } from "@/lib/channelSources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// The channel lane's cheap half: list, triage, and write description-tier
// sources. No Gemini, no Firecrawl.
//
// SPLIT FROM /api/channels/transcribe FOR THE REASON /api/sweep IS SPLIT FROM
// /api/sync. Transcription is minutes of Gemini per video, so a combined route
// would spend its 300s on the expensive rung and report "skipped: not enough
// time" for it every night — or, worse, do the cheap work and never reach the
// expensive work at all. Two routes, two clocks, two schedules.
//
// Measured cost of this route on the first live run: 6 Claude calls (~38k in /
// ~8k out), 9 YouTube quota units against 10,000/day, 0 Firecrawl credits.

function authorized(req: NextRequest): boolean {
  if (req.headers.get("x-vercel-cron")) return true;
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

async function handle(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const days = Number(req.nextUrl.searchParams.get("days") ?? 45);
  const max = Number(req.nextUrl.searchParams.get("max") ?? 40);
  const startedAt = Date.now();

  try {
    const sweep = await runChannelSweep({
      lookbackDays: Number.isFinite(days) ? Math.max(1, Math.min(365, days)) : 45,
      maxTriage: Number.isFinite(max) ? Math.max(1, Math.min(60, max)) : 40,
      // Leave 60s for the promote pass and the response.
      deadline: startedAt + 215_000,
    });

    // Description-tier sources. Cheap — no model call — so it runs in the same
    // invocation rather than waiting a day behind its own cron.
    const promoted = await promoteDescriptionSources({ deadline: startedAt + 275_000 });

    return NextResponse.json(
      {
        ok: true,
        trigger: req.headers.get("x-vercel-cron") ? "cron" : "manual",
        listed: sweep.enumerated.map((e) => ({
          channel: e.label,
          listed: e.listed,
          excluded: e.excluded,
          fresh: e.fresh,
          linked: e.linked,
          quotaUnits: e.quotaUnits,
        })),
        triaged: sweep.queue.length,
        relevant: sweep.triage.verdicts.filter((v) => v.verdict === "relevant").length,
        offTopic: sweep.triage.verdicts.filter((v) => v.verdict === "off_topic").length,
        missingVerdict: sweep.triage.missing.length,
        claudeCalls: sweep.triage.calls,
        sourceRows: promoted.rows,
        deferredToTranscript: promoted.deferred,
        elapsedMs: Date.now() - startedAt,
        warnings: [...sweep.warnings, ...promoted.warnings].slice(0, 20),
      },
      { status: 200 },
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
