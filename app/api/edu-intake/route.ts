import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { runEduIntake } from "@/lib/eduIntake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// The Broad Educational intake: stock the inbox (lib/eduIntake.ts).
//
// Its own cron and its own clock, for the reason /api/sweep is not part of
// /api/sync: a step that always gets cut for time is a step that does not
// exist. Nightly, after the sync and the sweep have landed, so the analog
// shelf's newest current-tier rows are on the shelf before intake reads them.
//
// Spends money (Firecrawl credits, xAI for the three Grok lenses, one Claude
// call per candidate), so it is authenticated like the other spending routes:
// the x-vercel-cron header, or a CRON_SECRET bearer. ONE addition over
// /api/sweep: a signed-in operator may run it from the "Run intake now" button
// on the Prioritize card. The browser cannot hold CRON_SECRET, and asking the
// operator to curl a route defeats the point of the button, so a valid Google
// session (eco.com only, see auth.ts) is accepted too. proxy.ts exempts this
// path from the session redirect so the cron is not bounced to the sign-in
// page the way /api/channels was from 2 Sep to 15 Oct.
async function authorized(req: NextRequest): Promise<boolean> {
  if (req.headers.get("x-vercel-cron")) return true;
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") === `Bearer ${secret}`) return true;
  const session = await auth();
  return !!session?.user;
}

async function handle(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const startedAt = Date.now();
  const cron = !!req.headers.get("x-vercel-cron");
  const q = req.nextUrl.searchParams;
  const n = (k: string, d: number, max: number) => {
    const v = Number(q.get(k));
    return Number.isFinite(v) && v > 0 ? Math.min(max, Math.round(v)) : d;
  };
  try {
    const r = await runEduIntake({
      trigger: cron ? "cron" : "manual",
      // Leave 25s to write the response.
      deadline: startedAt + 275_000,
      maxScrapes: n("scrapes", 15, 40),
      perLens: n("perLens", 4, 8),
      analogSources: n("analog", 6, 20),
      skipGrok: q.get("grok") === "0",
    });
    return NextResponse.json({ ok: true, trigger: cron ? "cron" : "manual", ...r, elapsedMs: Date.now() - startedAt });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

// GET for Vercel Cron; POST for a manual run.
export const GET = handle;
export const POST = handle;
