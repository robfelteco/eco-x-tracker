import { getPostsWithLatest, getLastSyncRun, getPostCount, getReviewCount } from "@/lib/queries";
import { TEMPLATE_BY_ID } from "@/lib/taxonomy";
import { Eyebrow, Tag, Thumb } from "@/app/components/ui";
import { Sidebar } from "@/app/components/Sidebar";
import { ReorganizeSelect } from "@/app/components/ReorganizeSelect";
import { ExpandableText } from "@/app/components/ExpandableText";
import { pickThumb } from "@/lib/media";

export const dynamic = "force-dynamic";

function fmt(n: number | null): string {
  return n == null ? "—" : n.toLocaleString();
}
function dateFmt(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
}

export default async function PostsPage() {
  const [posts, lastSync, total, reviewCount] = await Promise.all([
    getPostsWithLatest(200),
    getLastSyncRun(),
    getPostCount(),
    getReviewCount(),
  ]);

  return (
    <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6">
      <Sidebar reviewCount={reviewCount} />
      <main className="min-w-0 flex-1">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Eyebrow>All posts · raw ingest</Eyebrow>
          <p className="mt-1.5 text-sm text-white/55">
            {total} post{total === 1 ? "" : "s"} stored · latest metric snapshot shown per row
          </p>
        </div>
      </div>

      {lastSync && (
        <div className="mb-4 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-[11px] text-white/45">
          last sync ({lastSync.trigger}) {lastSync.finished_at ? dateFmt(lastSync.finished_at) : "running…"} —{" "}
          <span className={lastSync.ok === false ? "text-amber-300" : "text-white/70"}>
            {lastSync.summary ?? "—"}
          </span>
        </div>
      )}

      {posts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 p-12 text-center text-sm text-white/45">
          No posts yet. Click <span className="text-white/80">Refresh now</span> to pull the most recent 100, or{" "}
          <span className="text-white/80">Backfill history</span> for the full ~3,200.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-white/10 scroll-thin">
          <table className="w-full min-w-[900px] border-collapse text-sm">
            <thead>
              <tr className="bg-white/[0.03] text-left font-mono text-[10px] uppercase tracking-wider text-white/40">
                <th className="px-3 py-2.5 font-medium">Date</th>
                <th className="px-3 py-2.5 font-medium">Media</th>
                <th className="px-3 py-2.5 font-medium">Text</th>
                <th className="px-3 py-2.5 font-medium">Flags</th>
                <th className="px-3 py-2.5 font-medium">Template</th>
                <th className="px-3 py-2.5 text-right font-medium">Impr.</th>
                <th className="px-3 py-2.5 text-right font-medium">Likes</th>
                <th className="px-3 py-2.5 text-right font-medium">Replies</th>
                <th className="px-3 py-2.5 text-right font-medium">Snaps</th>
                <th className="px-3 py-2.5 font-medium">Reorganize</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((p) => (
                <tr key={p.id} className="border-t border-white/[0.07] transition hover:bg-white/[0.03]">
                  <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[11px] text-white/45 tabular-nums">
                    {dateFmt(p.created_at)}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <Thumb src={pickThumb(p)} href={p.url} />
                      <span className="font-mono text-[10px] text-white/40">{p.media_type}</span>
                    </div>
                  </td>
                  <td className="max-w-md px-3 py-2.5 align-top">
                    <ExpandableText text={p.text?.trim() || p.link_title} lines={2} />
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {p.is_self_reply && <Tag tone="brand">self-reply</Tag>}
                      {p.is_reply && !p.is_self_reply && <Tag>reply</Tag>}
                      {p.is_quote && <Tag>quote</Tag>}
                      {p.amplified && <Tag tone="amber">amplified</Tag>}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    {p.template ? (
                      <span className="text-white/80">
                        {TEMPLATE_BY_ID[p.template]?.label ?? p.template}
                        {p.confidence != null && (
                          <span className="ml-1 font-mono text-[10px] text-white/35">{p.confidence.toFixed(2)}</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-white/30">unclassified</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-white/80">{fmt(p.impressions)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-white/70">{fmt(p.likes)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-white/70">{fmt(p.replies)}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-[11px] tabular-nums text-white/35">
                    {p.snapshot_count}
                  </td>
                  <td className="px-3 py-2.5">
                    <ReorganizeSelect postId={p.id} current={p.template} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </main>
    </div>
  );
}
