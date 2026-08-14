"use client";

import { useMemo, useState } from "react";
import type { TopPost } from "@/lib/stats";
import { Thumb } from "@/app/components/ui";
import { ExpandableText } from "@/app/components/ExpandableText";
import { ReorganizeSelect } from "@/app/components/ReorganizeSelect";
import { pickThumb } from "@/lib/media";

type Sort = "impressions" | "recent" | "engagement";

const SORTS: { id: Sort; label: string }[] = [
  { id: "impressions", label: "Impressions" },
  { id: "recent", label: "Most recent" },
  { id: "engagement", label: "Engagement" },
];

function fmt(n: number | null): string {
  return n == null ? "—" : n.toLocaleString();
}

// Total engagement actions on a post's latest snapshot. Used for the
// "Engagement" sort so the operator can surface posts that resonated, not just
// the ones that reached the most people.
function engagement(p: TopPost): number {
  return (p.likes ?? 0) + (p.replies ?? 0) + (p.bookmarks ?? 0);
}

// Every post in a template/window, re-sortable in place. Default order is
// most-impressions-first (the query already returns them that way); switching to
// "Most recent" or "Engagement" re-sorts client-side with no round-trip, so the
// filter/window navigation state is untouched.
export function TemplatePostsTable({ posts }: { posts: TopPost[] }) {
  const [sort, setSort] = useState<Sort>("impressions");

  const sorted = useMemo(() => {
    const rows = [...posts];
    if (sort === "recent") {
      // created_at arrives as a Date across the RSC boundary (pg returns Dates),
      // so compare by timestamp rather than string.
      rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    } else if (sort === "engagement") {
      rows.sort((a, b) => engagement(b) - engagement(a));
    } else {
      rows.sort((a, b) => (b.impressions ?? -1) - (a.impressions ?? -1));
    }
    return rows;
  }, [posts, sort]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-white/40">
          All posts · {posts.length}
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-white/35">Sort</span>
          <div className="flex rounded-lg border border-white/10 bg-white/[0.03] p-0.5">
            {SORTS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSort(s.id)}
                className={`rounded-md px-2.5 py-1 text-xs transition ${
                  sort === s.id
                    ? "bg-eco-lightblue/15 text-eco-lightblue"
                    : "text-white/55 hover:text-white/80"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-white/10 scroll-thin">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="bg-white/[0.03] text-left font-mono text-[10px] uppercase tracking-wider text-white/40">
              <th className="px-3 py-2.5 font-medium">Date</th>
              <th className="px-3 py-2.5 font-medium">Media</th>
              <th className="px-3 py-2.5 font-medium">Text</th>
              <th className="px-3 py-2.5 text-right font-medium">Impr.</th>
              <th className="px-3 py-2.5 text-right font-medium">Likes</th>
              <th className="px-3 py-2.5 text-right font-medium">Replies</th>
              <th className="px-3 py-2.5 text-right font-medium">Bookmarks</th>
              <th className="px-3 py-2.5 font-medium">Reorganize</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-white/40">
                  No posts in this template/window.
                </td>
              </tr>
            ) : (
              sorted.map((p) => (
                <tr key={p.id} className="border-t border-white/[0.07] transition hover:bg-white/[0.03]">
                  <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[11px] text-white/50 align-top">
                    {new Date(p.created_at).toISOString().slice(0, 10)}
                  </td>
                  <td className="px-3 py-2.5 align-top">
                    <Thumb src={pickThumb(p)} href={p.url} />
                  </td>
                  <td className="max-w-md px-3 py-2.5 align-top">
                    <ExpandableText text={p.text} lines={1} />
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-white/80 align-top">{fmt(p.impressions)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-white/60 align-top">{fmt(p.likes)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-white/60 align-top">{fmt(p.replies)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-white/60 align-top">{fmt(p.bookmarks)}</td>
                  <td className="px-3 py-2.5 align-top">
                    <ReorganizeSelect postId={p.id} current={p.template} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
