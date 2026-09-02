import { NextRequest, NextResponse } from "next/server";
import { runSync } from "@/lib/ingest";
import { runRuleClassification, runClaudeClassification } from "@/lib/classify";
import { runAnalogSweep } from "@/lib/analogSweep";
import { runMomentumSweep } from "@/lib/chainMomentum";
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
  // The sweep runs LAST and is the only step that can be safely cut short, so
  // it gets whatever is left of the function's 300s rather than a fixed slice.
  const startedAt = Date.now();
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


    // Chain momentum — read each watched chain's own timeline and roll it up
    // per day. Runs here, in the post sync, because that is what it is FOR: the
    // pairing of "this chain is ripping" with "and you last mentioned it five
    // weeks ago" only means anything if both halves are read on the same clock.
    //
    // Bounded on purpose. ~11 enabled chains × 5 posts ≈ 55 reads/day ≈ $0.28,
    // and it is skipped rather than half-run when the handler is short of time,
    // because a partial sweep would write a day row for some chains and not
    // others and the baselines would drift apart.
    let momentum: Awaited<ReturnType<typeof runMomentumSweep>> | null = null;
    try {
      const left = 300_000 - (Date.now() - startedAt) - 30_000;
      if (left < 30_000) {
        momentum = { chains: 0, days: 0, reads: 0, costUsd: 0, spikes: [], warnings: ["skipped: not enough time left"] };
      } else {
        momentum = await runMomentumSweep(sql, { deadline: Date.now() + left });
      }
    } catch (err) {
      momentum = {
        chains: 0, days: 0, reads: 0, costUsd: 0, spikes: [],
        warnings: [err instanceof Error ? err.message.slice(0, 200) : String(err)],
      };
    }

    // ------------------------------------------------------------------
    // The analog-source sweep, OFF by default here.
    //
    // It used to default to four concepts at the end of this handler, and the
    // first production run showed why that cannot work: by the time ingest,
    // rule and Claude classification, article attribution and the docs/video
    // shelves are done, there is not enough of the 300s left, so the sweep
    // reported "skipped: not enough time left in this run" and would have done
    // that every night. It now has its own cron and its own clock at
    // /api/sweep. ?sweep=N here is a manual escape hatch only.
    // ------------------------------------------------------------------
    const sweepParam = req.nextUrl.searchParams.get("sweep");
    const sweepCount = sweepParam == null ? 0 : Math.max(0, Math.min(20, Number(sweepParam) || 0));
    let sweep: { concepts: number; added: number; credits: number; warnings: string[] } | null = null;
    if (sweepCount > 0) {
      try {
        const budgetMs = 300_000 - (Date.now() - startedAt) - 20_000; // leave room to respond
        if (budgetMs < 45_000) {
          sweep = { concepts: 0, added: 0, credits: 0, warnings: ["skipped: not enough time left in this run"] };
        } else {
          const r = await runAnalogSweep({
            concepts: sweepCount,
            deadline: Date.now() + budgetMs,
            maxScrapes: 4,
          });
          sweep = {
            concepts: r.results.length,
            added: r.totalAdded,
            credits: r.totalCredits,
            warnings: [...r.warnings, ...r.results.flatMap((x) => x.warnings)].slice(0, 12),
          };
        }
      } catch (err) {
        sweep = {
          concepts: 0,
          added: 0,
          credits: 0,
          warnings: [err instanceof Error ? err.message.slice(0, 200) : String(err)],
        };
      }
    }

    return NextResponse.json(
      {
        ...result,
        classified: { ruleSettled, claudeClassified, errors: classifyErrors },
        shelves,
        articlesMatched,
        momentum,
        sweep,
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
