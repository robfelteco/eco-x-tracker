import { getInsights, type Recommendation, type ChainAngle, type Readiness, type SuggestedPost } from "@/lib/stats";
import { getReviewCount } from "@/lib/queries";
import { Sidebar } from "@/app/components/Sidebar";
import { FilterBar } from "@/app/components/FilterBar";
import { parseFilter } from "@/lib/filter";
import { Eyebrow, Badge, Thumb } from "@/app/components/ui";
import { writtenDate, daysAgo, compact } from "@/lib/format";
import { pickThumb } from "@/lib/media";

export const dynamic = "force-dynamic";

const READINESS_LABEL: Record<Readiness, string> = {
  due: "Due",
  soon: "Soon",
  fresh: "Just posted",
  never: "Never posted",
};

function readinessBadge(r: Readiness) {
  const tone = r === "due" ? "warning" : r === "never" ? "brand" : "neutral";
  return <Badge tone={tone}>{READINESS_LABEL[r]}</Badge>;
}

// The single best angle to actually run: highest median impressions among chains
// that aren't freshly posted. Null when the pillar isn't chain-oriented.
function bestUntappedAngle(chains: ChainAngle[]): ChainAngle | null {
  return chains.find((c) => c.readiness !== "fresh") ?? null;
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filter = parseFilter(await searchParams);
  const [{ recommendations, reAmplify }, reviewCount] = await Promise.all([
    getInsights(filter),
    getReviewCount(),
  ]);

  const actionable = recommendations.filter((r) => r.score > 0);
  const resting = recommendations.filter((r) => r.score === 0);

  return (
    <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6">
      <Sidebar reviewCount={reviewCount} />
      <main className="min-w-0 flex-1">
        <Eyebrow>Insights</Eyebrow>
        <h1 className="mt-1.5 text-2xl font-medium tracking-[-0.02em]">What should I post today?</h1>
        <p className="mt-1 max-w-2xl text-sm text-white/45">
          Pillars ranked by performance × how overdue they are. Freshly-posted pillars drop off — what&apos;s left
          is what to reach for next.
        </p>

        <div className="mt-4">
          <FilterBar />
        </div>

        {/* Post next */}
        <div className="mt-6 flex items-center justify-between">
          <Eyebrow>Post next</Eyebrow>
          <span className="font-mono text-[10px] text-white/30">{actionable.length} due or warming</span>
        </div>

        {actionable.length === 0 ? (
          <p className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-6 text-center text-sm text-white/40">
            Nothing overdue in this window — every pillar was posted recently. Nice cadence.
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            {actionable.map((rec, i) => (
              <RecCard key={rec.template} rec={rec} rank={i + 1} />
            ))}
          </div>
        )}

        {resting.length > 0 && (
          <div className="mt-4 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3">
            <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-white/30">
              Recently covered — not due yet
            </div>
            <div className="flex flex-wrap gap-2">
              {resting.map((r) => (
                <span
                  key={r.template}
                  className="rounded-lg border border-white/[0.07] px-2.5 py-1 text-xs text-white/50"
                >
                  {r.label}
                  <span className="ml-1.5 text-white/25">
                    {r.daysSince == null ? "never" : daysAgo(r.daysSince)}
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Re-amplify */}
        {reAmplify.length > 0 && (
          <>
            <div className="mt-8">
              <Eyebrow>Re-amplify — past bangers worth another run</Eyebrow>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {reAmplify.map((p) => (
                <a
                  key={p.id}
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  className="group flex gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3 transition hover:border-eco-lightblue/40 hover:bg-white/[0.05]"
                >
                  <Thumb src={pickThumb(p)} size={56} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-white/35">
                      <span className="text-eco-lightblue/80">{compact(p.impressions)} impr</span>
                      <span>·</span>
                      <span>{p.templateLabel}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-white/80">{p.text}</p>
                    <div className="mt-1.5 font-mono text-[10px] text-white/35">
                      {writtenDate(p.created_at)} · {daysAgo(p.daysAgo)}
                    </div>
                  </div>
                </a>
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function RecCard({ rec, rank }: { rec: Recommendation; rank: number }) {
  const best = bestUntappedAngle(rec.chains);
  const top = rank === 1;
  return (
    <div
      className={`rounded-2xl border p-4 transition ${
        top ? "border-eco-lightblue/40 bg-eco-lightblue/[0.04]" : "border-white/10 bg-white/[0.03]"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* LEFT = the actionable stuff (Jay: keep the mouse on the left). */}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-white/30">#{rank}</span>
            <h3 className="text-base font-medium text-white/90">{rec.label}</h3>
            {readinessBadge(rec.readiness)}
          </div>
          <div className="mt-1 text-sm text-white/50">
            Last posted <span className="text-white/70">{writtenDate(rec.lastPosted)}</span>
            {rec.daysSince != null && <span className="text-white/40"> · {daysAgo(rec.daysSince)}</span>}
          </div>
          {best && (
            <div className="mt-2 text-sm text-white/70">
              Best angle:{" "}
              <span className="font-medium text-eco-lightblue">{best.label}</span>
              <span className="text-white/45">
                {" "}
                — {compact(best.medianImpr)} median impr
                {best.daysSince != null ? `, last used ${daysAgo(best.daysSince)}` : ", never used"}
              </span>
            </div>
          )}
        </div>
        {/* RIGHT = read-only context stats. */}
        <div className="flex flex-none gap-4 text-right">
          <Metric label="Median impr" value={compact(rec.medianImpr)} />
          <Metric label="Avg eng" value={rec.avgEngRate == null ? "—" : `${(rec.avgEngRate * 100).toFixed(1)}%`} />
          <Metric label="90d posts" value={String(rec.count90)} />
        </div>
      </div>

      {rec.suggested && <SuggestedPostBlock post={rec.suggested} />}

      {rec.chains.length > 0 && (
        <div className="mt-3 border-t border-white/[0.07] pt-3">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-white/30">
            Chain angles — best performing first
          </div>
          <div className="flex flex-wrap gap-1.5">
            {rec.chains.map((c) => (
              <ChainChip key={c.chain} c={c} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// The concrete "post this" prescription: the proven, ≤3-month-old post to put
// back out for this pillar. Clickable straight through to X.
function SuggestedPostBlock({ post }: { post: SuggestedPost }) {
  return (
    <div className="mt-3 border-t border-white/[0.07] pt-3">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-white/30">
        Post this — proven piece, last 3 months
      </div>
      <a
        href={post.url}
        target="_blank"
        rel="noreferrer"
        className="group flex gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-2.5 transition hover:border-eco-lightblue/40 hover:bg-white/[0.05]"
      >
        <Thumb src={pickThumb(post)} size={52} />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm text-white/85">{post.link_title || post.text}</p>
          <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-white/35">
            <span className="text-eco-lightblue/80">{compact(post.impressions ?? 0)} impr</span>
            <span>·</span>
            <span>{writtenDate(post.created_at)}</span>
            <span>·</span>
            <span>{daysAgo(post.daysAgo)}</span>
            <span className="text-eco-lightblue/70 opacity-0 transition group-hover:opacity-100">· open on X ↗</span>
          </div>
        </div>
      </a>
    </div>
  );
}

function ChainChip({ c }: { c: ChainAngle }) {
  const fresh = c.readiness === "fresh";
  return (
    <span
      title={`${c.count} post${c.count === 1 ? "" : "s"} · median ${compact(c.medianImpr)} impr · last ${
        c.daysSince == null ? "never" : daysAgo(c.daysSince)
      }`}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs ${
        fresh
          ? "border-white/[0.06] text-white/30"
          : "border-white/12 bg-white/[0.04] text-white/75"
      }`}
    >
      <span className="font-medium">{c.label}</span>
      <span className="font-mono text-[10px] text-white/40">{compact(c.medianImpr)}</span>
      <span className={`font-mono text-[10px] ${fresh ? "text-white/25" : "text-white/40"}`}>
        {c.daysSince == null ? "—" : `${c.daysSince}d`}
      </span>
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-white/30">{label}</div>
      <div className="mt-0.5 text-sm font-medium tabular-nums text-white/85">{value}</div>
    </div>
  );
}
