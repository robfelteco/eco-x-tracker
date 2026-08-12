import type { WeeklyPoint } from "@/lib/stats";

// Posts-per-week bar chart (pure CSS, no dependency). Gaps in cadence show as
// short/empty bars at a glance.
export function Bars({ data }: { data: WeeklyPoint[] }) {
  if (!data.length) return <p className="text-sm text-white/40">No posts in this window.</p>;
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="flex items-end gap-1 overflow-x-auto pb-1 scroll-thin" style={{ height: 120 }}>
      {data.map((d) => (
        <div key={d.week} className="flex flex-none flex-col items-center gap-1" title={`${d.week}: ${d.count}`}>
          <div className="flex h-[92px] items-end">
            <div
              className="w-3 rounded-t bg-eco-lightblue/70"
              style={{ height: `${Math.max(3, (d.count / max) * 92)}px` }}
            />
          </div>
          <span className="font-mono text-[8px] text-white/25">{d.week.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}
