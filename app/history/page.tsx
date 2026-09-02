import { sql } from "@/lib/db";
import { getTemplateTrends, TREND_WINDOW, type TemplateTrend, type TrendPost } from "@/lib/trend";
import { getReviewCount } from "@/lib/queries";
import { parseFilter } from "@/lib/filter";
import { Sidebar } from "@/app/components/Sidebar";
import { FilterBar } from "@/app/components/FilterBar";
import { Eyebrow } from "@/app/components/ui";
import { writtenDate, compact } from "@/lib/format";

export const dynamic = "force-dynamic";

// The trend board. This tab used to show "what the tool actually drove" — every
// recommendation marked as used, tied to the post it produced. That loop needed
// a button pressed to record anything, the copy drafter turned out to be used
// rarely, and so the page was mostly empty and the signal behind it too sparse
// to move a score.
//
// What replaces it is the thing Jay asked for on the 2 Sep call: each pillar's
// last five posts against the five before them, so a format that is cooling is
// visible before you have written ten more into it. Every post feeds it and
// nothing has to be logged.
//
// It reports and does not diagnose, deliberately — see lib/trend.ts.

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const filter = parseFilter(sp);
  const [trends, reviewCount] = await Promise.all([getTemplateTrends(sql, filter), getReviewCount()]);

  const ranked = trends
    .filter((t) => t.template !== "other")
    .sort((a, b) => {
      // Declining first — that is the list you act on. Then improving, then the
      // pillars with nothing to say yet.
      const rank = (t: TemplateTrend) =>
        t.flag === "declining" ? 0 : t.flag === "improving" ? 1 : t.flag === "flat" ? 2 : 3;
      return rank(a) - rank(b) || (a.imprPct ?? 0) - (b.imprPct ?? 0);
    });

  const declining = ranked.filter((t) => t.flag === "declining");

  return (
    <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6">
      <Sidebar reviewCount={reviewCount} />
      <main className="min-w-0 flex-1">
        <Eyebrow>Trend</Eyebrow>
        <h1 className="mt-1.5 text-2xl font-medium tracking-[-0.02em]">Which formats are cooling</h1>
        <p className="mt-1 max-w-2xl text-sm text-white/45">
          Each pillar&apos;s last {TREND_WINDOW} posts against the {TREND_WINDOW} before them, on median
          impressions and median engagements. It tells you what to look at, not what is wrong — a drop can be the
          angle, the hour, the format wearing out, or the timeline being busy, and only you can tell which.
        </p>

        <div className="mt-4">
          <FilterBar />
        </div>

        {declining.length > 0 && (
          <p className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-4 py-3 text-sm text-amber-200/90">
            {declining.length === 1 ? (
              <>
                <span className="font-medium">{declining[0].label}</span> is down{" "}
                {Math.abs(declining[0].imprPct ?? 0).toFixed(0)}% — worth reviewing the angle before the next one.
              </>
            ) : (
              <>
                <span className="font-medium">{declining.length} pillars</span> are down against their own prior{" "}
                {TREND_WINDOW}: {declining.map((d) => d.label).join(", ")}.
              </>
            )}
          </p>
        )}

        <div className="mt-4 space-y-2">
          {ranked.map((t) => (
            <TrendRow key={t.template} t={t} />
          ))}
        </div>

        <p className="mt-6 text-xs text-white/30">
          Medians, not means — one launch post at 300k drags a five-post mean above anything the pillar will do
          again, so a mean-based trend reads &ldquo;declining&rdquo; for a fortnight purely because the outlier aged
          out of the window.
        </p>
      </main>
    </div>
  );
}

const TONE: Record<string, { dot: string; text: string; label: string }> = {
  improving: { dot: "bg-emerald-400", text: "text-emerald-300", label: "Improving" },
  declining: { dot: "bg-amber-400", text: "text-amber-300", label: "Declining" },
  flat: { dot: "bg-white/30", text: "text-white/50", label: "Flat" },
  insufficient: { dot: "bg-white/15", text: "text-white/30", label: "Not enough posts" },
};

function TrendRow({ t }: { t: TemplateTrend }) {
  const tone = TONE[t.flag];
  const enough = t.flag !== "insufficient";

  return (
    <details className="group rounded-xl border border-white/10 bg-white/[0.03]">
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3 px-4 py-3 list-none">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`h-1.5 w-1.5 flex-none rounded-full ${tone.dot}`} />
          <span className="truncate text-sm font-medium text-white/85">{t.label}</span>
          <span className="font-mono text-[10px] text-white/30">{t.n} posts</span>
        </div>

        <div className="flex flex-none items-center gap-5 text-right">
          {enough ? (
            <>
              <Delta label="Impressions" recent={t.recentImpr} prior={t.priorImpr} pct={t.imprPct} />
              <Delta label="Engagements" recent={t.recentEng} prior={t.priorEng} pct={t.engPct} />
              <span className={`w-20 text-xs font-medium ${tone.text}`}>{tone.label}</span>
            </>
          ) : (
            <span className="text-xs text-white/30">
              Needs {TREND_WINDOW + 2} posts to compare — has {t.n}
            </span>
          )}
        </div>
      </summary>

      {t.posts.length > 0 && (
        <div className="border-t border-white/[0.07] px-4 py-3">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-white/30">
            The posts behind it — newest first, the first {TREND_WINDOW} are the recent window
          </div>
          <div className="space-y-1">
            {t.posts.map((p, i) => (
              <PostLine key={p.id} p={p} inRecent={i < TREND_WINDOW} />
            ))}
          </div>
        </div>
      )}
    </details>
  );
}

function Delta({
  label,
  recent,
  prior,
  pct,
}: {
  label: string;
  recent: number | null;
  prior: number | null;
  pct: number | null;
}) {
  return (
    <div className="w-32">
      <div className="font-mono text-[10px] uppercase tracking-wider text-white/30">{label}</div>
      <div className="mt-0.5 text-sm tabular-nums text-white/80">
        {compact(recent)} <span className="text-white/25">from</span> {compact(prior)}
        {pct != null && (
          <span className={pct >= 0 ? " text-emerald-300/80" : " text-amber-300/80"}>
            {" "}
            {pct >= 0 ? "+" : ""}
            {pct.toFixed(0)}%
          </span>
        )}
      </div>
    </div>
  );
}

function PostLine({ p, inRecent }: { p: TrendPost; inRecent: boolean }) {
  return (
    <div className={`flex items-center gap-3 text-xs ${inRecent ? "text-white/70" : "text-white/40"}`}>
      <span className="w-20 flex-none font-mono text-[10px] text-white/30">{writtenDate(p.createdAt)}</span>
      <a href={p.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate hover:text-eco-lightblue">
        {p.text}
      </a>
      {p.amplified && (
        <span className="flex-none rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[9px] text-white/45">amp</span>
      )}
      <span className="w-16 flex-none text-right tabular-nums">{compact(p.impressions)}</span>
      <span className="w-12 flex-none text-right tabular-nums text-white/40">{compact(p.engagements)}</span>
    </div>
  );
}
