import type { RatioMeter as Meter } from "@/lib/ratio";
import { RATIO_BUCKETS, type RatioBucket } from "@/lib/taxonomy";
import { Tooltip } from "@/app/components/ui";

// The 4-1-1 week strip. Sits above the pillar list on Prioritize, because the
// pillar list cannot see the ratio: every pillar can be fresh while the week
// runs four promo posts for every educational one, which is what the account
// did for the two months before this shipped.
//
// Three numbers, a share bar, and one sentence saying what closes the gap.
// Server component: everything it shows is already computed in lib/ratio.ts.

const TONE: Record<RatioBucket, { bar: string; text: string }> = {
  edu: { bar: "bg-eco-lightblue", text: "text-eco-lightblue" },
  soft: { bar: "bg-white/40", text: "text-white/70" },
  hard: { bar: "bg-white/20", text: "text-white/50" },
};

export function RatioMeter({ meter }: { meter: Meter }) {
  const short = meter.eduDeficit > 0 && meter.total > 0;
  return (
    <div
      className={`mt-4 rounded-2xl border px-4 py-3 ${
        short ? "border-amber-300/30 bg-amber-300/[0.05]" : "border-white/10 bg-white/[0.03]"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-baseline gap-2">
          <Tooltip text="Four educational posts for every soft promo and every hard promo. Counted over the last seven days, all main posts, amplified and organic alike.">
            <span className="cursor-help font-mono text-[10px] uppercase tracking-wider text-white/40 underline decoration-dotted decoration-white/25 underline-offset-2">
              4-1-1 · last 7 days
            </span>
          </Tooltip>
          <span className="font-mono text-[10px] text-white/30">{meter.total} posts</span>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
          {meter.week.map((b) => {
            const delta = b.count - meter.prior[b.bucket];
            const breakdown = b.byPillar.length
              ? b.byPillar.map((p) => `${p.label} ${p.count}`).join(" · ")
              : "none this week";
            return (
              <Tooltip key={b.bucket} text={`${RATIO_BUCKETS[b.bucket].hint} This week: ${breakdown}.`}>
                <span className="flex cursor-help items-baseline gap-1.5">
                  <span className={`text-lg font-semibold tabular-nums leading-none ${TONE[b.bucket].text}`}>
                    {b.count}
                  </span>
                  <span className="text-xs text-white/55">{b.label.toLowerCase()}</span>
                  {delta !== 0 && (
                    <span className="font-mono text-[10px] tabular-nums text-white/30">
                      {delta > 0 ? "+" : ""}
                      {delta} wk
                    </span>
                  )}
                </span>
              </Tooltip>
            );
          })}
        </div>
      </div>

      {/* The share bar. Target is the 4-in-6 line, drawn so the eye reads the
          gap between where the educational share is and where it should be. */}
      <div className="relative mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
        {meter.total > 0 && (
          <div className="flex h-full w-full">
            {meter.week.map((b) => (
              <div
                key={b.bucket}
                className={`h-full ${TONE[b.bucket].bar}`}
                style={{ width: `${(100 * b.count) / meter.total}%` }}
              />
            ))}
          </div>
        )}
        <div
          className="absolute top-0 h-full w-px bg-white/70"
          style={{ left: `${(100 * RATIO_BUCKETS.edu.target) / 6}%` }}
          title="Where the educational share should end: four of every six posts"
        />
      </div>

      <p className={`mt-2 text-xs ${short ? "text-amber-200/90" : "text-white/45"}`}>
        {meter.eduShare != null && (
          <span className="mr-1.5 font-mono tabular-nums text-white/40">{Math.round(meter.eduShare * 100)}% educational ·</span>
        )}
        {meter.verdict}
      </p>
    </div>
  );
}
