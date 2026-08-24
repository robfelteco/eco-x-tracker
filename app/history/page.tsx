import { getHistory, type HistoryRow } from "@/lib/recUses";
import { getReviewCount } from "@/lib/queries";
import { Sidebar } from "@/app/components/Sidebar";
import { Eyebrow, Badge } from "@/app/components/ui";
import { writtenDate, daysAgo, compact } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const [rows, reviewCount] = await Promise.all([getHistory(), getReviewCount()]);

  const matched = rows.filter((r) => r.status === "matched");
  const open = rows.filter((r) => r.status === "open");

  return (
    <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6">
      <Sidebar reviewCount={reviewCount} />
      <main className="min-w-0 flex-1">
        <Eyebrow>History</Eyebrow>
        <h1 className="mt-1.5 text-2xl font-medium tracking-[-0.02em]">What the tool actually drove</h1>
        <p className="mt-1 max-w-2xl text-sm text-white/45">
          Every recommendation you marked as used, tied to the post it produced and how that post performed against
          the pillar&apos;s baseline. This is the loop — the engine only takes credit for what it drove, and learns
          from the results.
        </p>

        {rows.length === 0 ? (
          <p className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-10 text-center text-sm text-white/40">
            Nothing yet. On the{" "}
            <a href="/" className="text-eco-lightblue hover:underline">
              Prioritize
            </a>{" "}
            board, click <span className="text-white/70">Mark as used</span> when you act on a recommendation — it
            shows up here once the resulting post is synced.
          </p>
        ) : (
          <>
            {open.length > 0 && (
              <section className="mt-6">
                <div className="mb-2 flex items-center gap-2">
                  <Eyebrow>Waiting on a post</Eyebrow>
                  <span className="font-mono text-[10px] text-white/30">{open.length}</span>
                </div>
                <div className="space-y-2">
                  {open.map((r) => (
                    <OpenRow key={r.id} r={r} />
                  ))}
                </div>
              </section>
            )}

            <section className="mt-8">
              <div className="mb-2 flex items-center gap-2">
                <Eyebrow>Posted &amp; measured</Eyebrow>
                <span className="font-mono text-[10px] text-white/30">{matched.length}</span>
              </div>
              {matched.length === 0 ? (
                <p className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 py-6 text-center text-sm text-white/35">
                  No attributed posts yet — they attach at the next sync after you post.
                </p>
              ) : (
                <div className="space-y-2">
                  {matched.map((r) => (
                    <MatchedRow key={r.id} r={r} />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function Meta({ r }: { r: HistoryRow }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-medium text-white/85">{r.templateLabel}</span>
      {r.chainLabel && (
        <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-white/60">{r.chainLabel}</span>
      )}
      {r.scoreAtUse != null && (
        <span className="font-mono text-[10px] text-white/35">score {r.scoreAtUse} when used</span>
      )}
    </div>
  );
}

function OpenRow({ r }: { r: HistoryRow }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <div className="min-w-0">
        <Meta r={r} />
        <div className="mt-1 font-mono text-[10px] text-white/35">
          Marked {writtenDate(r.usedAt)} · {daysAgo(daysSinceISO(r.usedAt))}
        </div>
      </div>
      <Badge tone="warning">Awaiting post</Badge>
    </div>
  );
}

function MatchedRow({ r }: { r: HistoryRow }) {
  const beat = r.impressions != null && r.pillarMedian != null ? r.impressions >= r.pillarMedian : null;
  const ratio = r.impressions != null && r.pillarMedian ? r.impressions / r.pillarMedian : null;
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Meta r={r} />
          {r.postText && (
            <a
              href={r.postUrl ?? "#"}
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 block max-w-2xl truncate text-sm text-white/70 hover:text-eco-lightblue"
            >
              {r.postText}
            </a>
          )}
          <div className="mt-1.5 font-mono text-[10px] text-white/35">
            Posted {writtenDate(r.postCreatedAt)} · marked {writtenDate(r.usedAt)}
          </div>
        </div>
        <div className="flex flex-none items-center gap-4 text-right">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wider text-white/30">Impressions</div>
            <div className="mt-0.5 text-sm font-medium tabular-nums text-white/85">{compact(r.impressions)}</div>
          </div>
          {beat != null && (
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                beat ? "bg-emerald-400/15 text-emerald-300" : "bg-amber-400/15 text-amber-300"
              }`}
              title={`Pillar baseline median: ${compact(r.pillarMedian)} impressions`}
            >
              {beat ? "Beat" : "Under"} baseline{ratio != null ? ` · ${(ratio * 100).toFixed(0)}%` : ""}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// Days since an ISO timestamp (History renders on the server; no client clock).
function daysSinceISO(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}
