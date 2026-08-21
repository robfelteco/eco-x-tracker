"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { TEMPLATE_DEFS } from "@/lib/taxonomy";

// Left rail: Overview, one entry per template, All posts, Review queue. Preserves
// the current filter (amplified/date) across navigation via the query string.
export function Sidebar({ reviewCount }: { reviewCount?: number }) {
  const pathname = usePathname();
  const qs = useSearchParams().toString();
  const suffix = qs ? `?${qs}` : "";

  const item = (href: string, label: string, active: boolean, badge?: number) => (
    <Link
      key={href}
      href={`${href}${suffix}`}
      className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 text-sm transition ${
        active ? "bg-white/[0.07] text-white" : "text-white/55 hover:bg-white/[0.04] hover:text-white/90"
      }`}
    >
      <span className="truncate">{label}</span>
      {badge ? (
        <span className="ml-2 rounded-full bg-amber-400/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">
          {badge}
        </span>
      ) : null}
    </Link>
  );

  return (
    <nav className="flex w-56 flex-none flex-col gap-0.5">
      {item("/insights", "Prioritize", pathname === "/insights")}
      {item("/", "Raw", pathname === "/")}
      <div className="mt-3 mb-1 px-2.5 font-mono text-[10px] uppercase tracking-wider text-white/30">Templates</div>
      {TEMPLATE_DEFS.filter((t) => t.id !== "other").map((t) =>
        item(`/t/${t.id}`, t.label, pathname === `/t/${t.id}`),
      )}
      {item(`/t/other`, "Other", pathname === `/t/other`)}
      <div className="mt-3 mb-1 px-2.5 font-mono text-[10px] uppercase tracking-wider text-white/30">Data</div>
      {item("/history", "History", pathname === "/history")}
      {item("/posts", "All posts", pathname === "/posts")}
      {item("/review", "Review queue", pathname === "/review", reviewCount)}
    </nav>
  );
}
