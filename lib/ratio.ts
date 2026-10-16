import { TEMPLATE_BY_ID, RATIO_BUCKETS, type RatioBucket, type Template } from "./taxonomy.ts";

// The 4-1-1 meter: what the account actually posted this week, by bucket, and
// how far that is from four educational posts per soft and per hard promo.
//
// This is a clock the pillar scorer does not have. scoreParts() asks "is this
// pillar overdue against its own cadence", and every pillar can answer "no"
// while the week runs 80% promo. The meter asks the other question: of what
// went out, how much was for the reader rather than for us.
//
// A rolling seven days rather than a calendar week, on purpose. The operator
// looks at this on a Wednesday and wants to know what the last week of the feed
// looked like, not what has happened since Monday.

export interface RatioBucketCount {
  bucket: RatioBucket;
  label: string;
  count: number;
  /** Which pillars made up the count, largest first. */
  byPillar: { template: Template; label: string; count: number }[];
}

export interface RatioMeter {
  /** Posts in the last seven days, by bucket. Always all three, in edu/soft/hard order. */
  week: RatioBucketCount[];
  /** Same for the seven days before, for the "vs last week" read. */
  prior: Record<RatioBucket, number>;
  /** Main posts counted this week (excludes `other`). */
  total: number;
  /** Educational share of the week, 0..1. Null when nothing was posted. */
  eduShare: number | null;
  /** How many more educational posts bring the week to 4-1-1 at the current promo count. */
  eduDeficit: number;
  /** Plain-English line for the strip. */
  verdict: string;
}

type SqlTag = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...params: unknown[]
) => Promise<T[]>;

const ORDER: RatioBucket[] = ["edu", "soft", "hard"];

// A post's bucket. Declared on the pillar, with the one per-post exception: a
// Data Motion Visual with no chain as its subject is market-wide data, which is
// educational. Same rule lib/dmvLanes.ts lanes them by.
export function bucketOf(template: Template, chainCount: number): RatioBucket | null {
  if (template === "data_motion_visual" && chainCount === 0) return "edu";
  return TEMPLATE_BY_ID[template]?.ratioBucket ?? null;
}

// The 4-1-1 holds when edu is at least four times the LARGER of the two promo
// buckets, not four times their sum. Four edu, one soft and one hard is the
// target; four edu, two soft and zero hard is the same promo weight and should
// read the same. Anchoring on the max makes "post less promo" and "post more
// edu" both move the needle in the right direction.
export function eduTarget(soft: number, hard: number): number {
  return RATIO_BUCKETS.edu.target * Math.max(soft, hard);
}

export async function getRatioMeter(sql: SqlTag): Promise<RatioMeter> {
  const rows = await sql<{ template: Template; chainCount: number; thisWeek: boolean }>`
    SELECT p.template::text AS template,
           cardinality(p.chains)::int AS "chainCount",
           (p.created_at >= now() - interval '7 days') AS "thisWeek"
    FROM posts p
    WHERE p.is_reply = false
      AND p.created_at >= now() - interval '14 days'
  `;

  const week = new Map<RatioBucket, Map<Template, number>>(ORDER.map((b) => [b, new Map()]));
  const prior: Record<RatioBucket, number> = { edu: 0, soft: 0, hard: 0 };

  for (const r of rows) {
    const b = bucketOf(r.template, r.chainCount);
    if (!b) continue;
    if (r.thisWeek) {
      const m = week.get(b)!;
      m.set(r.template, (m.get(r.template) ?? 0) + 1);
    } else {
      prior[b] += 1;
    }
  }

  const counts: RatioBucketCount[] = ORDER.map((b) => {
    const m = week.get(b)!;
    const byPillar = [...m.entries()]
      .map(([template, count]) => ({ template, label: TEMPLATE_BY_ID[template].label, count }))
      .sort((a, b) => b.count - a.count);
    return { bucket: b, label: RATIO_BUCKETS[b].label, count: byPillar.reduce((n, p) => n + p.count, 0), byPillar };
  });

  const n = (b: RatioBucket) => counts.find((c) => c.bucket === b)!.count;
  const edu = n("edu");
  const soft = n("soft");
  const hard = n("hard");
  const total = edu + soft + hard;
  const target = eduTarget(soft, hard);
  const eduDeficit = Math.max(0, target - edu);

  let verdict: string;
  if (total === 0) verdict = "Nothing posted in the last seven days.";
  else if (eduDeficit === 0) verdict = "On the 4-1-1. Keep the educational count ahead of promo.";
  else {
    // The two honest ways out of a deficit. Say both: the ratio is a ratio.
    const promoHold = Math.max(soft, hard) - Math.floor(edu / RATIO_BUCKETS.edu.target);
    verdict =
      `${eduDeficit} more educational post${eduDeficit === 1 ? "" : "s"} to reach 4-1-1 at this week's promo count` +
      (promoHold > 0 ? `, or ${promoHold} fewer promo post${promoHold === 1 ? "" : "s"}.` : ".");
  }

  return {
    week: counts,
    prior,
    total,
    eduShare: total ? edu / total : null,
    eduDeficit,
    verdict,
  };
}
