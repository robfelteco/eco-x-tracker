import Link from "next/link";
import { getOverview } from "@/lib/stats";
import { getReviewCount, getPostCount, getLastSyncRun } from "@/lib/queries";
import { Sidebar } from "@/app/components/Sidebar";
import { FilterBar } from "@/app/components/FilterBar";
import { parseFilter } from "@/lib/filter";
import { Eyebrow } from "@/app/components/ui";

export const dynamic = "force-dynamic";

function fmt(n: number | null): string {
  return n == null ? "—" : n.toLocaleString();
}
function pct(n: number | null): string {
  return n == null ? "—" : `${(n * 100).toFixed(1)}%`;
}

// Staleness color for days-since-last-post vs the template's threshold.
function staleClass(daysSince: number | null, staleDays: number): string {
  if (daysSince == null) return "text-white/30";
  if (daysSince > staleDays) return "text-red-400";
  if (daysSince > staleDays * 0.6) return "text-amber-300";
  return "text-emerald-300";
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const filter = parseFilter(sp);
  const [rows, reviewCount, total, lastSync] = await Promise.all([
    getOverview(filter),
    getReviewCount(),
    getPostCount(),
    getLastSyncRun(),
  ]);

  return (
    <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6">
      <Sidebar reviewCount={reviewCount} />
      <main className="min-w-0 flex-1">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <Eyebrow>Overview</Eyebrow>
            <h1 className="mt-1.5 text-2xl font-medium tracking-[-0.02em]">The whole bag, one screen</h1>
            <p className="mt-1 text-sm text-white/45">
              {total.toLocaleString()} posts · last sync{" "}
              {lastSync?.finished_at ? new Date(lastSync.finished_at).toLocaleString() : "never"} · auto-refreshes daily
            </p>
          </div>
        </div>

        <div className="mb-4">
          <FilterBar />
        </div>

        <div className="overflow-x-auto rounded-2xl border border-white/10 scroll-thin">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr className="bg-white/[0.03] text-left font-mono text-[10px] uppercase tracking-wider text-white/40">
                <th className="px-3 py-2.5 font-medium">Template</th>
                <th className="px-3 py-2.5 font-medium">Last posted</th>
                <th className="px-3 py-2.5 text-right font-medium">Days since</th>
                <th className="px-3 py-2.5 text-right font-medium">30d</th>
                <th className="px-3 py-2.5 text-right font-medium">90d</th>
                <th className="px-3 py-2.5 text-right font-medium">Median impr</th>
                <th className="px-3 py-2.5 text-right font-medium">Avg eng</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.template} className="border-t border-white/[0.07] transition hover:bg-white/[0.03]">
                  <td className="px-3 py-2.5">
                    <Link href={`/t/${r.template}`} className="font-medium text-white/90 hover:text-eco-lightblue">
                      {r.label}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[11px] text-white/50">
                    {r.lastPosted ? new Date(r.lastPosted).toISOString().slice(0, 10) : "never"}
                  </td>
                  <td className={`px-3 py-2.5 text-right font-medium tabular-nums ${staleClass(r.daysSince, r.staleDays)}`}>
                    {r.daysSince ?? "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-white/70">{r.count30}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-white/50">{r.count90}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-white/80">{fmt(r.medianImpr)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-white/70">{pct(r.avgEngRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 font-mono text-[10px] text-white/30">
          Days-since colored vs each template&apos;s cadence threshold · green ok · amber warming · red stale
        </p>
      </main>
    </div>
  );
}
