import type { AmpFilter, StatFilter } from "./stats.ts";

// Server-safe filter parsing (no "use client"). Server components import this;
// the FilterBar client component only renders the controls.
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
