"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type { AmpFilter, StatFilter } from "@/lib/stats";

// Parse the amplified/date filter from URL search params (server-side use).
export function parseFilter(sp: Record<string, string | string[] | undefined>): StatFilter {
  const ampRaw = typeof sp.amp === "string" ? sp.amp : "all";
  const amplified: AmpFilter = ampRaw === "organic" || ampRaw === "amplified" ? ampRaw : "all";
  const range = typeof sp.range === "string" ? sp.range : "all";
  let since: string | null = null;
  const now = Date.now();
  if (range === "30d") since = new Date(now - 30 * 86400000).toISOString();
  else if (range === "90d") since = new Date(now - 90 * 86400000).toISOString();
  else if (range === "180d") since = new Date(now - 180 * 86400000).toISOString();
  else if (range === "2026") since = "2026-01-01T00:00:00Z";
  return { amplified, since };
}

const AMP_OPTS: { value: AmpFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "organic", label: "Organic" },
  { value: "amplified", label: "Amplified" },
];
const RANGE_OPTS = [
  { value: "all", label: "All time" },
  { value: "2026", label: "2026" },
  { value: "90d", label: "90 days" },
  { value: "30d", label: "30 days" },
];

export function FilterBar() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const amp = sp.get("amp") ?? "all";
  const range = sp.get("range") ?? "all";

  function set(key: string, value: string) {
    const next = new URLSearchParams(sp.toString());
    if (value === "all") next.delete(key);
    else next.set(key, value);
    router.push(`${pathname}?${next.toString()}`);
  }

  const group = (
    current: string,
    opts: { value: string; label: string }[],
    key: string,
    label: string,
  ) => (
    <div className="flex items-center gap-2">
      <span className="font-mono text-[10px] uppercase tracking-wider text-white/30">{label}</span>
      <div className="flex items-center gap-1 rounded-full border border-white/10 p-0.5">
        {opts.map((o) => (
          <button
            key={o.value}
            onClick={() => set(key, o.value)}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
              current === o.value ? "bg-white/[0.09] text-white" : "text-white/50 hover:text-white/90"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="flex flex-wrap items-center gap-4">
      {group(amp, AMP_OPTS, "amp", "Attribution")}
      {group(range, RANGE_OPTS, "range", "Window")}
    </div>
  );
}
