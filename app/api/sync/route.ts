import { NextRequest, NextResponse } from "next/server";
import { runSync } from "@/lib/ingest";
import { runRuleClassification, runClaudeClassification } from "@/lib/classify";
import { attributeUses } from "@/lib/recUses";
import { sql } from "@/lib/db";
import { attributeArticles } from "@/lib/articleAttribution";
import { syncDocPages, attributeDocPages } from "@/lib/docs";
import { tagDocPages } from "@/lib/docsTag";
import { syncYouTubeVideos } from "@/lib/videos";
import { tagVideos } from "@/lib/videoTag";
import { matchVideosToPosts } from "@/lib/videoMatch";
import { makeClaudeMatcher } from "@/lib/articleMatchClaude";

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

    // Tie newly-ingested posts to the article they amplify. Most land on a free
    // deterministic rung (a blog URL, an X-article card, or a link at the @eco
    // post that carried the piece); only the leftovers cost a Claude call. This
    // is what keeps the article shelves one-row-per-article instead of
    // one-row-per-amplification. Best-effort — never fails the sync.
    let articlesMatched = 0;
    try {
      const cost = { usd: 0 };
      const res = await attributeArticles(sql, { claudeMatch: makeClaudeMatcher(cost) });
      articlesMatched = Object.values(res.matched).reduce((a, b) => a + b, 0);
      classifyErrors.push(...res.errors.slice(0, 5));
    } catch (err) {
      classifyErrors.push(err instanceof Error ? err.message.slice(0, 200) : String(err));
    }

    // Close the recursion loop: tie any open "marked as used" recommendations to
    // Refresh the two registry-first shelves.
    //
    // Docs: llms.txt is regenerated whenever the docs site ships, so new pages
    // appear here on their own. Only pages with no tier cost a Claude call, so
    // a sync that finds three new pages costs three, not seventy-three.
    //
    // Videos: the YouTube listing is cheap (uploads playlist, 1 unit a page) and
    // catches clips published since the last run; tagging and post-matching are
    // capped so one sync can never turn into a huge Claude bill. The DROPBOX
    // side is deliberately absent — this runtime has no Dropbox credentials, so
    // the file/transcript layer is seeded from db/dropbox-shorts-manifest.json
    // by scripts/sync-videos.ts. See that file's header.
    const shelves: Record<string, unknown> = {};
    try {
      const d = await syncDocPages();
      const da = await attributeDocPages();
      const dt = await tagDocPages();
      shelves.docs = { new: d.inserted, bodies: d.bodiesFetched, attributed: da.matched, tagged: dt.tagged };
      classifyErrors.push(...d.errors.slice(0, 3), ...dt.errors.slice(0, 3));
    } catch (err) {
      classifyErrors.push(`docs shelf: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    }
    try {
      const y = await syncYouTubeVideos();
      const vt = await tagVideos({ limit: 60 });
      const vm = await matchVideosToPosts({ limit: 40 });
      shelves.videos = { new: y.inserted, shorts: y.shorts, tagged: vt.tagged, matched: vm.matched };
      classifyErrors.push(...y.errors.slice(0, 3), ...vt.errors.slice(0, 3));
    } catch (err) {
      classifyErrors.push(`video shelf: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    }

    // the @eco posts that fulfilled them (newly-classified above). Best-effort —
    // never fails the sync.
    let attributed = 0;
    try {
      attributed = await attributeUses();
    } catch (err) {
      classifyErrors.push(err instanceof Error ? err.message.slice(0, 200) : String(err));
    }

    return NextResponse.json(
      {
        ...result,
        classified: { ruleSettled, claudeClassified, errors: classifyErrors },
        shelves,
        articlesMatched,
        attributed,
      },
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
