import { sql } from "@/lib/db";
import { getMomentum, SPIKE_MULTIPLE, BASELINE_DAYS, MIN_BASELINE_DAYS, type ChainMomentum } from "@/lib/chainMomentum";
import { getReviewCount } from "@/lib/queries";
import { TEMPLATE_BY_ID, isTemplate } from "@/lib/taxonomy";
import { Sidebar } from "@/app/components/Sidebar";
import { Eyebrow } from "@/app/components/ui";
import { compact, daysAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

// Chain momentum. Two facts side by side, because neither is a call to action
// on its own: how much attention a chain is getting right now, and how long it
// has been since Eco said anything about it.
//
// A chain that is spiking and that we have gone quiet on is the top of this
// page. A chain that is spiking and that we posted about yesterday is fine and
// sits lower. A quiet chain is not a story no matter how long the clock has run,
// which is the thing the chain pillar's own clock could never tell you.

export default async function MomentumPage() {
  const [rows, reviewCount] = await Promise.all([getMomentum(sql), getReviewCount()]);

  const spiking = rows.filter((r) => r.spiking);
  // The actual to-do list: hot, and we're not talking about it.
  const actionable = spiking.filter((r) => (r.ecoCoverDaysSince ?? 9999) >= 14);

  return (
    <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6">
      <Sidebar reviewCount={reviewCount} />
      <main className="min-w-0 flex-1">
        <Eyebrow>Momentum</Eyebrow>
        <h1 className="mt-1.5 text-2xl font-medium tracking-[-0.02em]">Which chains are ripping</h1>
        <p className="mt-1 max-w-2xl text-sm text-white/45">
          Each watched chain&apos;s own account, last 7 days against its previous {BASELINE_DAYS - 7}. A chain is
          flagged at {SPIKE_MULTIPLE}× its own baseline — never against other chains, because Base&apos;s quiet week
          beats most chains&apos; best one. Refreshed once a day with the post sync, and it needs about{" "}
          {MIN_BASELINE_DAYS + 7} days of those runs before any chain has enough history to be called a spike.
        </p>

        {rows.length === 0 ? (
          <p className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-10 text-center text-sm text-white/40">
            No momentum data yet — it fills in on the next daily sync.
          </p>
        ) : (
          <>
            {actionable.length > 0 && (
              <div className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] px-4 py-3">
                <div className="font-mono text-[10px] uppercase tracking-wider text-emerald-300/70">Post about this</div>
                <ul className="mt-1.5 space-y-1 text-sm text-emerald-100/90">
                  {actionable.map((r) => (
                    <li key={r.chain}>
                      <span className="font-medium">{r.label}</span> is at {r.ratio}× its baseline
                      {r.ecoCoverDaysSince != null ? (
                        <> and we last mentioned it {daysAgo(r.ecoCoverDaysSince)}</>
                      ) : (
                        <> and we have never mentioned it</>
                      )}
                      {r.integrated ? (
                        <span className="text-emerald-300/70"> · Eco is live here</span>
                      ) : (
                        <span className="text-emerald-300/50"> · not integrated — market angle only</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-4 space-y-2">
              {rows.map((r) => (
                <MomentumRow key={r.chain} r={r} />
              ))}
            </div>

            <p className="mt-6 text-xs text-white/30">
              Read from each chain&apos;s official account only — not mentions across all of X. That would be the
              better signal and roughly fifty times the API bill; this is the version that stays cheap enough to run
              every day.
            </p>
          </>
        )}
      </main>
    </div>
  );
}

function MomentumRow({ r }: { r: ChainMomentum }) {
  const coverLabel =
    r.ecoCoverTemplate && isTemplate(r.ecoCoverTemplate) ? TEMPLATE_BY_ID[r.ecoCoverTemplate].label : null;

  return (
    <details className="group rounded-xl border border-white/10 bg-white/[0.03]">
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3 px-4 py-3 list-none">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={`h-1.5 w-1.5 flex-none rounded-full ${r.spiking ? "bg-emerald-400" : "bg-white/25"}`}
          />
          <span className="truncate text-sm font-medium text-white/85">{r.label}</span>
          {r.integrated ? (
            <span className="rounded bg-eco-blue/20 px-1.5 py-0.5 font-mono text-[9px] text-eco-lightblue">live</span>
          ) : (
            <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[9px] text-white/40">
              not integrated
            </span>
          )}
        </div>

        <div className="flex flex-none items-center gap-5 text-right">
          <Sparkline series={r.series} />
          <div className="w-24">
            <div className="font-mono text-[10px] uppercase tracking-wider text-white/30">vs baseline</div>
            <div className={`mt-0.5 text-sm tabular-nums ${r.spiking ? "text-emerald-300" : "text-white/70"}`}>
              {r.ratio == null ? "—" : `${r.ratio}×`}
            </div>
          </div>
          <div className="w-24">
            <div className="font-mono text-[10px] uppercase tracking-wider text-white/30">7d engagement</div>
            <div className="mt-0.5 text-sm tabular-nums text-white/70">{compact(r.recentEng)}</div>
          </div>
          <div className="w-28">
            <div className="font-mono text-[10px] uppercase tracking-wider text-white/30">Eco last posted</div>
            <div className="mt-0.5 text-sm tabular-nums text-white/70">
              {r.ecoCoverDaysSince == null ? "never" : daysAgo(r.ecoCoverDaysSince)}
            </div>
          </div>
        </div>
      </summary>

      <div className="border-t border-white/[0.07] px-4 py-3 text-xs text-white/55">
        {r.topPostText ? (
          <>
            <div className="font-mono text-[10px] uppercase tracking-wider text-white/30">
              Their biggest post this week{r.topPostEng != null && ` — ${compact(r.topPostEng)} engagements`}
            </div>
            <p className="mt-1 max-w-3xl whitespace-pre-wrap text-white/70">{r.topPostText}</p>
            {r.topPostId && (
              <a
                href={`https://x.com/i/status/${r.topPostId}`}
                target="_blank"
                rel="noreferrer"
                className="mt-1.5 inline-block text-eco-lightblue hover:underline"
              >
                Open on X →
              </a>
            )}
          </>
        ) : (
          <span className="text-white/35">No posts captured in the last 7 days.</span>
        )}
        <div className="mt-3 font-mono text-[10px] text-white/30">
          {r.postsRecent} posts in 7d · baseline{" "}
          {r.baselineEng == null
            ? `not established yet — ${r.baselineDays} of ${MIN_BASELINE_DAYS} days needed`
            : `${compact(r.baselineEng)} engagements/day over ${r.baselineDays} days`}
          {coverLabel && ` · Eco's last mention was a ${coverLabel}`}
        </div>
      </div>
    </details>
  );
}

// Bare inline bars. A chain's own series only — the scale is per-row, so heights
// are never comparable between rows and the component never implies they are.
function Sparkline({ series }: { series: { day: string; eng: number }[] }) {
  if (series.length < 2) return <div className="w-24" />;
  const max = Math.max(...series.map((s) => s.eng), 1);
  return (
    <div className="flex h-6 w-24 items-end gap-px" aria-hidden>
      {series.slice(-21).map((s) => (
        <div
          key={s.day}
          className="flex-1 rounded-sm bg-white/25"
          style={{ height: `${Math.max(6, (s.eng / max) * 100)}%` }}
          title={`${s.day}: ${s.eng}`}
        />
      ))}
    </div>
  );
}
