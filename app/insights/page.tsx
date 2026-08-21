import {
  getInsights,
  type Recommendation,
  type Readiness,
  type TLArticle,
  type BroadEdBreakdown,
} from "@/lib/stats";
import { getReviewCount } from "@/lib/queries";
import { Sidebar } from "@/app/components/Sidebar";
import { FilterBar } from "@/app/components/FilterBar";
import { parseFilter } from "@/lib/filter";
import { Eyebrow, Badge, Thumb, Tooltip } from "@/app/components/ui";
import { writtenDate, daysAgo, compact } from "@/lib/format";
import { pickThumb } from "@/lib/media";
import { METRIC_DEFS } from "@/lib/metricDefs";
import { RecActions, type Target } from "@/app/components/RecActions";

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

function mediaLabel(t: string | null): string | null {
  switch (t) {
    case "video": return "video";
    case "animated_gif": return "GIF";
    case "photo": return "image";
    case "link-card": return "article/link";
    case "text": return "text";
    default: return null;
  }
}

function scoreTone(score: number): string {
  if (score >= 66) return "border-red-400/40 bg-red-400/10 text-red-300";
  if (score >= 33) return "border-amber-300/40 bg-amber-300/10 text-amber-200";
  return "border-white/15 bg-white/[0.04] text-white/70";
}

export default async function PrioritizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filter = parseFilter(await searchParams);
  const [{ recommendations, reAmplify, recentChains, thoughtLeadership, broadEducational }, reviewCount] =
    await Promise.all([getInsights(filter), getReviewCount()]);

  const actionable = recommendations.filter((r) => r.score > 0);
  const resting = recommendations.filter((r) => r.score === 0);

  return (
    <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6">
      <Sidebar reviewCount={reviewCount} />
      <main className="min-w-0 flex-1">
        <Eyebrow>Prioritize</Eyebrow>
        <h1 className="mt-1.5 text-2xl font-medium tracking-[-0.02em]">What should I post next?</h1>
        <p className="mt-1 max-w-2xl text-sm text-white/45">
          Every pillar scored 0–100 on how overdue it is against how well it performs. Freshly-posted pillars
          drop to the bottom — what&apos;s ranked at the top is what to reach for right now.
        </p>

        <div className="mt-4">
          <FilterBar />
        </div>

        {recentChains.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-white/35">In the feed this week</span>
            {recentChains.map((c) => (
              <span key={c.chain} className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-0.5 text-xs text-white/70">
                {c.label}
                <span className="ml-1 font-mono text-[10px] text-white/35">{c.count}</span>
              </span>
            ))}
            <span className="text-[11px] text-white/30">— ride an adjacent angle while these are warm</span>
          </div>
        )}

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
              <RecCard key={rec.template} rec={rec} rank={i + 1} tlArticles={thoughtLeadership} broadEd={broadEducational} />
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
                <span key={r.template} className="rounded-lg border border-white/[0.07] px-2.5 py-1 text-xs text-white/50">
                  {r.label}
                  <span className="ml-1.5 text-white/25">{r.daysSince == null ? "never" : daysAgo(r.daysSince)}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {reAmplify.length > 0 && (
          <>
            <div className="mt-8 flex items-center gap-2">
              <Eyebrow>Re-amplify — past bangers worth another run</Eyebrow>
              <Tooltip text={METRIC_DEFS.reAmplify}>
                <span className="cursor-help font-mono text-[11px] text-white/25">?</span>
              </Tooltip>
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

// Build the draftable targets + mode for a recommendation. Thought-leadership
// rides on its article shelf; broad-educational on Discover; chain pillars on
// their ranked chain angles; everything else gets a single generic target.
function buildActions(
  rec: Recommendation,
  tlArticles: TLArticle[],
  broadEd: BroadEdBreakdown,
): { mode: "chains" | "articles" | "broad" | "generic"; targets: Target[]; broad?: BroadEdBreakdown } {
  if (rec.template === "thought_leadership") {
    const targets: Target[] = tlArticles.map((a) => ({
      key: `art-${a.id}`,
      label: a.title.slice(0, 140),
      sublabel: `score ${a.score} · ${compact(a.impressions)} impr · ${writtenDate(a.created_at)}${
        mediaLabel(a.mediaType) ? ` · ${mediaLabel(a.mediaType)}` : ""
      }`,
      basePostText: a.title,
      angle: "Fresh take pointing to this article",
      href: a.url,
    }));
    return { mode: "articles", targets };
  }
  if (rec.template === "broad_educational") {
    return { mode: "broad", targets: [], broad: broadEd };
  }
  if (rec.chains.length > 0) {
    const bestIdx = rec.chains.findIndex((c) => c.readiness !== "fresh");
    const base = rec.suggested?.link_title || rec.suggested?.text || null;
    const targets: Target[] = rec.chains.map((c, i) => ({
      key: `chain-${c.chain}`,
      label: c.label,
      sublabel: `${i === bestIdx ? "Best · " : ""}${compact(c.medianImpr)} median impr · ${
        c.daysSince == null ? "never used" : `last ${daysAgo(c.daysSince)}`
      }`,
      chain: c.chain,
      basePostText: base,
      angle: `${c.label} angle`,
    }));
    return { mode: "chains", targets };
  }
  const base = rec.suggested?.link_title || rec.suggested?.text || null;
  return {
    mode: "generic",
    targets: [{ key: "generic", label: `Draft a fresh ${rec.label}`, basePostText: base, angle: null }],
  };
}

function RecCard({
  rec,
  rank,
  tlArticles,
  broadEd,
}: {
  rec: Recommendation;
  rank: number;
  tlArticles: TLArticle[];
  broadEd: BroadEdBreakdown;
}) {
  const top = rank === 1;
  const lastType = mediaLabel(rec.lastMediaType);
  const { mode, targets, broad } = buildActions(rec, tlArticles, broadEd);
  return (
    <div className={`rounded-2xl border p-4 transition ${top ? "border-eco-lightblue/40 bg-eco-lightblue/[0.04]" : "border-white/10 bg-white/[0.03]"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-white/30">#{rank}</span>
            <h3 className="text-base font-medium text-white/90">{rec.label}</h3>
            {readinessBadge(rec.readiness)}
            {rec.easyWin && (
              <Tooltip text="Low-effort format — a quick post that doesn't need a big lift. Easy rep.">
                <span className="cursor-help rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">Easy win</span>
              </Tooltip>
            )}
          </div>
          <div className="mt-1 text-sm text-white/50">
            Last posted <span className="text-white/70">{writtenDate(rec.lastPosted)}</span>
            {lastType && <span className="text-white/40"> ({lastType})</span>}
            {rec.daysSince != null && <span className="text-white/40"> · {daysAgo(rec.daysSince)}</span>}
          </div>
          {rec.scoreReasons.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {rec.scoreReasons.map((why, i) => (
                <li key={i} className="text-xs text-white/55">
                  <span className="mr-1.5 text-white/25">›</span>
                  {why}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-none items-start gap-4">
          <Tooltip text={METRIC_DEFS.score}>
            <div className={`flex h-14 w-14 cursor-help flex-col items-center justify-center rounded-xl border ${scoreTone(rec.score)}`}>
              <span className="text-lg font-semibold leading-none tabular-nums">{rec.score}</span>
              <span className="mt-0.5 font-mono text-[8px] uppercase tracking-wider opacity-70">score</span>
            </div>
          </Tooltip>
          <div className="flex gap-4 text-right">
            <Metric label="Median impr" value={compact(rec.medianImpr)} def={METRIC_DEFS.medianImpr} />
            <Metric label="Avg eng" value={rec.avgEngRate == null ? "—" : `${(rec.avgEngRate * 100).toFixed(1)}%`} def={METRIC_DEFS.avgEng} />
            <Metric label="Posts 90d" value={String(rec.count90)} def={METRIC_DEFS.count90} />
          </div>
        </div>
      </div>

      <RecActions
        template={rec.template}
        score={rec.score}
        mode={mode}
        targets={targets}
        broad={broad}
        recDrivenCount={rec.recDrivenCount}
        recDrivenVsBaseline={rec.recDrivenVsBaseline}
      />
    </div>
  );
}

function Metric({ label, value, def }: { label: string; value: string; def: string }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-white/30">
        <Tooltip text={def} underline>
          {label}
        </Tooltip>
      </div>
      <div className="mt-0.5 text-sm font-medium tabular-nums text-white/85">{value}</div>
    </div>
  );
}
