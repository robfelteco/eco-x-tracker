import { chainLabel } from "./dimensions.ts";
import { TEMPLATE_BY_ID } from "./taxonomy.ts";

// Data Motion Visual, split into three lanes.
//
// It was the only pillar with no axis at all — draftMode "generic", one clock,
// one median — while every other pillar rotates on something (chains, products,
// articles, docs, clips). That made it the pillar that could look healthy while
// two thirds of what it does had gone quiet: a run of chain visuals kept the
// clock fresh, and "we have not done a broad market data visual in three weeks"
// had nowhere to appear.
//
// The three lanes, and the distinction that matters between the first two:
//
//   integrated  — data about a chain Eco is LIVE on. Every one of these can end
//                 with a reason to route through Eco, because we do.
//   other_chain — data about a chain we have NOT integrated. Same format, and
//                 a completely different post: there is no Eco call to action,
//                 the job is credibility on the market as a whole. Also the
//                 lane that quietly builds the case for integrating it.
//   market_wide — data with no single chain as its subject. Stablecoin supply,
//                 volume crossovers, market share shifts.
//
// Which chains count as integrated is DERIVED, not listed, so the split cannot
// drift out of date the way a hardcoded array would: a chain is integrated once
// it has an integration article or a post filed under New Chain Integrations.
// Adding a chain to lib/dimensions.ts does not silently make it "integrated".

export type DmvLaneId = "integrated" | "other_chain" | "market_wide";

export interface DmvLanePost {
  id: string;
  url: string;
  createdAt: string;
  text: string;
  impressions: number | null;
  chains: string[];
}

export interface DmvLane {
  id: DmvLaneId;
  label: string;
  /** What this lane is for, shown under the label. */
  hint: string;
  count: number;
  lastPosted: string | null;
  daysSince: number | null;
  medianImpr: number | null;
  readiness: "never" | "due" | "soon" | "fresh";
  /** Chains this lane has covered, coldest first. Empty for market_wide. */
  chains: { chain: string; label: string; count: number; daysSince: number | null }[];
  /** Most recent posts in the lane, newest first — the receipts. */
  recent: DmvLanePost[];
}

type SqlTag = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...params: unknown[]
) => Promise<T[]>;

const LANE_META: Record<DmvLaneId, { label: string; hint: string }> = {
  integrated: {
    label: "Integrated-chain data",
    hint: "Data about a chain Eco is live on. These can close on routing through Eco.",
  },
  other_chain: {
    label: "Non-integrated chain data",
    hint: "Chain-specific data where Eco isn't live yet. No Eco CTA — this lane buys credibility on the market, and builds the case for integrating.",
  },
  market_wide: {
    label: "Market-wide data",
    hint: "Stablecoin supply, volume, share shifts — no single chain as the subject.",
  },
};

// Each lane gets its own cadence. The pillar's 10 days was set when all three
// were one number; market-wide data moves slower than a chain's own metrics,
// and the non-integrated lane is a nice-to-have rather than an obligation.
const LANE_STALE_DAYS: Record<DmvLaneId, number> = {
  integrated: 10,
  other_chain: 21,
  market_wide: 14,
};

function readinessOf(daysSince: number | null, staleDays: number): DmvLane["readiness"] {
  if (daysSince == null) return "never";
  if (daysSince > staleDays) return "due";
  if (daysSince > staleDays * 0.6) return "soon";
  return "fresh";
}

export interface DmvFilterish {
  amplified: "all" | "organic" | "amplified";
  since: string | null;
}

/**
 * The three lanes, in a fixed order (integrated, other, market-wide) so the card
 * does not reshuffle between loads. Ranking happens inside the card on
 * readiness; the lanes themselves are a stable frame.
 */
export async function getDmvLanes(sql: SqlTag, filter: DmvFilterish): Promise<DmvLane[]> {
  const includeAll = filter.amplified === "all";
  const wantAmplified = filter.amplified === "amplified";

  // Which chains Eco is live on. Two sources, unioned: a seeded integration
  // article, or a post actually filed under the integration pillar.
  const integratedRows = await sql<{ chain: string }>`
    SELECT chain FROM articles WHERE chain IS NOT NULL AND kind = 'chain_integration'
    UNION
    SELECT unnest(chains) AS chain FROM posts
      WHERE template = 'integration_announcement' AND is_reply = false
  `;
  const integrated = new Set(integratedRows.map((r) => r.chain));

  const rows = await sql<{
    id: string;
    url: string;
    createdAt: string;
    text: string;
    impressions: number | null;
    chains: string[];
  }>`
    SELECT p.id, p.url, p.created_at AS "createdAt", p.text, s.impressions, p.chains
    FROM posts p
    LEFT JOIN LATERAL (
      SELECT * FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
    ) s ON true
    WHERE p.template = 'data_motion_visual'
      AND p.is_reply = false
      AND (${includeAll} OR p.amplified = ${wantAmplified})
      AND (${filter.since}::timestamptz IS NULL OR p.created_at >= ${filter.since}::timestamptz)
    ORDER BY p.created_at DESC
  `;

  // A post lands in exactly one lane. When a visual names both an integrated and
  // a non-integrated chain, the integrated one wins: the post could carry an Eco
  // close, so it belongs to the lane that is measuring whether we are making
  // those. Counting it in both would let one post keep two clocks fresh.
  const laneOf = (chains: string[]): DmvLaneId => {
    if (!chains.length) return "market_wide";
    return chains.some((c) => integrated.has(c)) ? "integrated" : "other_chain";
  };

  const buckets: Record<DmvLaneId, typeof rows> = {
    integrated: [] as unknown as typeof rows,
    other_chain: [] as unknown as typeof rows,
    market_wide: [] as unknown as typeof rows,
  };
  for (const r of rows) buckets[laneOf(r.chains ?? [])].push(r);

  const now = Date.now();
  const ids: DmvLaneId[] = ["integrated", "other_chain", "market_wide"];

  return ids.map((id) => {
    const posts = buckets[id];
    const staleDays = LANE_STALE_DAYS[id];
    const last = posts[0]?.createdAt ?? null;
    const daysSince = last ? Math.floor((now - new Date(last).getTime()) / 86_400_000) : null;

    const imprs = posts.map((p) => p.impressions).filter((x): x is number => x != null).sort((a, b) => a - b);
    const medianImpr = imprs.length
      ? imprs.length % 2
        ? imprs[Math.floor(imprs.length / 2)]
        : Math.round((imprs[imprs.length / 2 - 1] + imprs[imprs.length / 2]) / 2)
      : null;

    // Per-chain coverage inside the lane, coldest first — the same "what have we
    // not touched in a while" read the chain pillar gets.
    const byChain = new Map<string, { count: number; last: string }>();
    if (id !== "market_wide") {
      for (const p of posts) {
        for (const c of p.chains ?? []) {
          const inLane = id === "integrated" ? integrated.has(c) : !integrated.has(c);
          if (!inLane) continue;
          const cur = byChain.get(c);
          if (!cur) byChain.set(c, { count: 1, last: p.createdAt });
          else {
            cur.count++;
            if (new Date(p.createdAt) > new Date(cur.last)) cur.last = p.createdAt;
          }
        }
      }
    }

    return {
      id,
      label: LANE_META[id].label,
      hint: LANE_META[id].hint,
      count: posts.length,
      lastPosted: last,
      daysSince,
      medianImpr,
      readiness: readinessOf(daysSince, staleDays),
      chains: [...byChain.entries()]
        .map(([chain, v]) => ({
          chain,
          label: chainLabel(chain),
          count: v.count,
          daysSince: Math.floor((now - new Date(v.last).getTime()) / 86_400_000),
        }))
        .sort((a, b) => (b.daysSince ?? -1) - (a.daysSince ?? -1)),
      recent: posts.slice(0, 6).map((p) => ({
        id: p.id,
        url: p.url,
        createdAt: p.createdAt,
        text: p.text,
        impressions: p.impressions,
        chains: p.chains ?? [],
      })),
    };
  });
}

/**
 * The line the pillar card shows about its lanes, and the reason strings the
 * score picks up. Named lanes that are actually due, so "Data Motion Visual —
 * fresh" can still say "…but market-wide data is 24 days cold".
 */
export function dmvLaneReasons(lanes: DmvLane[]): string[] {
  const due = lanes.filter((l) => l.readiness === "due" || l.readiness === "never");
  if (!due.length) return [`All three data lanes are fresh`];
  return [
    `Cold lanes: ` +
      due
        .map((l) => `${l.label} (${l.daysSince == null ? "never" : `${l.daysSince}d`})`)
        .join(", "),
  ];
}

/** The pillar's own staleDays, for callers that want the frame in one place. */
export const DMV_PILLAR_STALE_DAYS = TEMPLATE_BY_ID.data_motion_visual.staleDays;

/**
 * The lane that is furthest past its own cadence, as a (daysSince, staleDays)
 * pair the pillar scorer can use directly.
 *
 * Why the pillar needs this. The first run of the split showed the failure it
 * was built to catch, and showed that splitting alone does not fix it: the
 * pillar read "fresh, posted 1d ago", scored 0, dropped to the resting list —
 * and Market-wide data was 35 days cold with nowhere to say so, because a
 * resting pillar's reasons are never displayed. The aggregate clock was doing
 * exactly what it had always done, just with better bookkeeping behind it.
 *
 * So a lane pillar is scored on its COLDEST LANE rather than its own last post.
 * Returns null when every lane is inside its cadence, in which case the pillar's
 * own clock is right and nothing needs overriding.
 */
export function coldestLane(lanes: DmvLane[]): { lane: DmvLane; staleDays: number; overdueBy: number } | null {
  let worst: { lane: DmvLane; staleDays: number; overdueBy: number } | null = null;
  for (const l of lanes) {
    const staleDays = LANE_STALE_DAYS[l.id];
    // A lane that has NEVER run is as overdue as it gets, but there is no clock
    // to measure it with — treat it as exactly at cadence so it registers as
    // due without swamping a lane that is genuinely months behind.
    const days = l.daysSince ?? staleDays + 1;
    const overdueBy = days - staleDays;
    if (overdueBy <= 0) continue;
    if (!worst || overdueBy / staleDays > worst.overdueBy / worst.staleDays) {
      worst = { lane: l, staleDays, overdueBy };
    }
  }
  return worst;
}
