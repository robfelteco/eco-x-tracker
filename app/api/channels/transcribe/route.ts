import { NextRequest, NextResponse } from "next/server";
import { runChannelTranscription } from "@/lib/channelTranscribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// The channel lane's expensive half: Gemini over the chapter windows triage
// flagged, then curriculum facts and quote candidates from the same transcript.
//
// THE DEFAULT IS DELIBERATELY SMALL. A windowed episode is 2-3 Gemini calls of a
// few minutes' audio each and a clip is one, but Gemini's video models return 503
// "high demand" readily (see GEMINI_VIDEO_FALLBACKS), so wall-clock per video is
// unpredictable. Four a run against a queue that grows by roughly one long-form
// episode a day keeps up without ever needing the whole 300s.
//
// Anything unreached stays transcribe_state='pending' and sorts first next run,
// so a short night costs latency and never coverage.

function authorized(req: NextRequest): boolean {
  if (req.headers.get("x-vercel-cron")) return true;
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

async function handle(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const n = Number(req.nextUrl.searchParams.get("limit") ?? 4);
  const limit = Math.max(1, Math.min(10, Number.isFinite(n) ? n : 4));
  const noQuotes = req.nextUrl.searchParams.get("quotes") === "0";
  const startedAt = Date.now();

  try {
    const r = await runChannelTranscription({
      limit,
      noQuotes,
      // Never START a video we cannot expect to finish; 25s left to respond.
      deadline: startedAt + 275_000,
    });
    return NextResponse.json(
      {
        // A fabricated-transcript abort is NOT a successful thin run. Report it
        // as failure so a monitoring glance cannot read it as a quiet day.
        ok: !r.aborted,
        aborted: r.aborted,
        trigger: req.headers.get("x-vercel-cron") ? "cron" : "manual",
        videos: r.outcomes.map((o) => ({
          title: o.title,
          channel: o.channel,
          windows: o.windows,
          minutes: o.minutes,
          reused: o.reused,
          factRows: o.factRows,
          quoteCandidates: o.quoteCandidates,
          verifyFailed: o.verifyFailed,
          skipped: o.skipped,
        })),
        minutesTranscribed: r.minutes,
        sourceRows: r.factRows,
        quoteCandidates: r.quoteCandidates,
        elapsedMs: Date.now() - startedAt,
        warnings: r.warnings.slice(0, 20),
      },
      { status: r.aborted ? 500 : 200 },
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
