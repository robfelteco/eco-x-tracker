import { NextRequest, NextResponse } from "next/server";
import { runAnalogSweep, pickConceptsToSweep } from "@/lib/analogSweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// The analog-source sweep, on its own cron and its own clock.
//
// WHY THIS IS NOT PART OF /api/sync. It was, and the first production run
// proved that wrong: the sync spends its 300s on ingest, rule and Claude
// classification, article attribution, the docs and video shelves, and use
// attribution. By the time the sweep was reached there was not enough budget
// left, so it reported "skipped: not enough time left in this run" and would
// have done that every night, silently, forever. A step that always gets cut is
// a step that does not exist.
//
// So the sweep gets a separate route with a fresh 300s and a separate schedule.
// /api/sync keeps a manual ?sweep=N escape hatch, but no longer runs it by
// default.
//
// Authenticated the same way as /api/sync, and for the same reason: Vercel Cron
// calls it without a user session, and it spends money (Firecrawl credits plus
// a Claude extraction call per concept).

function authorized(req: NextRequest): boolean {
  if (req.headers.get("x-vercel-cron")) return true;
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

async function handle(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Four a day is the budgeted default: measured Firecrawl costs are 2 credits a
  // search, 1 a map and 1 a scrape, so a concept runs 9-13 and four is ~40/day
  // against a 5,000/cycle plan. Every concept still refreshes every five days.
  const n = Number(req.nextUrl.searchParams.get("concepts") ?? 4);
  const concepts = Math.max(1, Math.min(20, Number.isFinite(n) ? n : 4));
  const startedAt = Date.now();

  try {
    const queued = await pickConceptsToSweep(concepts);
    const r = await runAnalogSweep({
      concepts,
      // Leave 25s to write the response. Anything unreached sorts first next
      // run, because the rotation is oldest-swept-first.
      deadline: startedAt + 275_000,
      maxScrapes: 4,
    });
    return NextResponse.json(
      {
        ok: true,
        trigger: req.headers.get("x-vercel-cron") ? "cron" : "manual",
        queued,
        swept: r.results.map((x) => ({
          id: x.analogId,
          label: x.label,
          scanned: x.scanned,
          added: x.added,
          rejected: x.rejected,
          credits: x.credits,
          partial: x.partial,
        })),
        totalAdded: r.totalAdded,
        totalCredits: r.totalCredits,
        elapsedMs: Date.now() - startedAt,
        warnings: [...r.warnings, ...r.results.flatMap((x) => x.warnings)].slice(0, 20),
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

// GET for Vercel Cron; POST for a manual run.
export const GET = handle;
export const POST = handle;
