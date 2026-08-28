import { sql } from "./db.ts";
import { ANALOG_DEFS, type AnalogDef, type AnalogTier } from "./analogs.ts";
import { ICP_BY_ID } from "./icp.ts";
import { getAllSources, type AnalogSource } from "./analogSources.ts";

// The curriculum shelf — a registry-first shelf like docs.ts and videos.ts.
//
// Registry-first matters here more than anywhere else in the app: this shelf's
// MOST valuable rows are the ones with no post attached. A concept we have
// never taught is the whole point. The article shelf is derived from posts and
// so can only ever show you what you have already done; this one starts from
// the twenty concepts and tells you which nineteen you have not.
//
// SCORING IS DELIBERATELY NOT scoreParts().
// stats.ts scores pillars on overdue-ness blended with performance percentile.
// That is the news rule, and it is wrong for a curriculum:
//
//   * News decays. A market stat from March is dead. So "days since last post"
//     is the right clock for a pillar.
//   * Curriculum does not decay. Correspondent banking was interesting in 1870
//     and it is interesting now. A concept we have never taught stays worth
//     teaching forever, and stops being worth teaching the moment we teach it
//     well.
//
// So the clock here is COVERAGE, not recency, and it is multiplied by two
// things a pillar score has no equivalent for: how sharp the concept's break is
// (a hand-set editorial judgment — teaching the strong ones first is the whole
// strategy), and whether its audience door has been walked through lately.

export interface CurriculumPost {
  id: string;
  url: string;
  text: string;
  template: string;
  createdAt: string;
  impressions: number | null;
}

// Which pillars count as TEACHING a concept, as opposed to merely mentioning it.
//
// This distinction is load-bearing and it was not in the first cut. Detection is
// keyword matching, so it finds mentions: a LI.FI quote card whose link title
// says "Liquidity Aggregation", a clip where a speaker mentions saving on SWIFT
// fees, a Stripe data-motion visual containing "payment processor". None of
// those taught the reader anything about the mechanism, and letting them
// suppress a concept's score would make the board claim coverage we do not have
// — the exact dishonesty this shelf exists to remove.
//
// Broad Educational and Thought Leadership are the two pillars whose JOB is
// explanation, so a concept appearing there is real coverage. Everywhere else
// it is a mention: worth showing, never worth cooling the score for.
const TEACHING_PILLARS = new Set(["broad_educational", "thought_leadership"]);

export interface CurriculumRow {
  analogId: string;
  label: string;
  tier: AnalogTier;
  side: "technical" | "commercial";
  icps: string[];
  icpLabels: string[];
  breakStrength: 1 | 2 | 3;
  parallel: string;
  breaksWhere: string;
  guardrail: string | null;
  // Verified source material from analog_sources. NOT the registry's static
  // list — these have been fetched and confirmed to resolve, and a concept with
  // none of them cannot be drafted from at all.
  sources: AnalogSource[];
  /** Posts that already touched this concept, newest first. Teaching + mentions. */
  posts: CurriculumPost[];
  /** Posts in a teaching pillar. This is the number coverage is scored on. */
  useCount: number;
  /** Posts that named the concept in passing, in a pillar that doesn't explain. */
  mentionCount: number;
  daysSinceLastUse: number | null;
  medianImpr: number | null;
  /** 0-100. Higher = teach this next. */
  score: number;
  /** No verified source material — drafting is blocked until this is fixed. */
  needsSources: boolean;
  /** Plain-English "why this score", same contract as Recommendation.scoreReasons. */
  reasons: string[];
}

export interface CurriculumMeta {
  /** Concepts with no verified source material — these cannot be drafted yet. */
  unsourced: number;
  totalConcepts: number;
  taught: number;
  neverTaught: number;
  /** Doors we have never once walked through, by ICP label. */
  coldDoors: string[];
  /** How many concepts each side has covered — the technical/commercial split. */
  bySide: { side: "technical" | "commercial"; total: number; taught: number }[];
}

export interface CurriculumShelf {
  rows: CurriculumRow[];
  meta: CurriculumMeta;
}

// A concept taught inside this window is genuinely fresh — don't queue it again.
const FRESH_DAYS = 21;
// Beyond this, a taught concept is fair game for a second, deeper pass.
const WARM_DAYS = 60;

const STRENGTH_WEIGHT: Record<1 | 2 | 3, number> = { 1: 0.6, 2: 0.8, 3: 1.0 };

const STRENGTH_REASON: Record<1 | 2 | 3, string> = {
  1: "Break is real but thin — supporting material, not a post subject",
  2: "Break is solid and differentiated",
  3: "Break is sharp — the strongest kind of post this shelf produces",
};

// How much of the score coverage can account for. A never-taught concept starts
// at full marks and decays as we teach it; a concept taught in the last three
// weeks drops far enough that something untaught always outranks it.
function coverageWeight(useCount: number, daysSince: number | null): { w: number; why: string } {
  if (useCount === 0) return { w: 1, why: "Never taught — no @eco post has explained this" };
  const depth = Math.max(0.15, 0.5 - 0.1 * (useCount - 1));
  if (daysSince == null) return { w: depth, why: `Touched ${useCount}× (no date)` };
  if (daysSince < FRESH_DAYS) {
    return { w: depth * 0.3, why: `Covered ${daysSince}d ago — let it rest` };
  }
  if (daysSince < WARM_DAYS) {
    return { w: depth * 0.6, why: `Covered ${daysSince}d ago — a deeper second pass is possible` };
  }
  return { w: depth, why: `Last covered ${daysSince}d ago — cold enough to revisit` };
}

export async function getCurriculumShelf(): Promise<CurriculumShelf> {
  const sourcesByConcept = await getAllSources();

  // One query for every analog-tagged post, with its latest impressions. Small
  // by construction — the whole point of this shelf is that very few posts
  // carry an analog_id.
  const rows = await sql<{
    id: string;
    url: string;
    text: string;
    template: string;
    analogId: string;
    createdAt: string;
    daysSince: number;
    impressions: number | null;
  }>`
    SELECT p.id, p.url, p.text, p.template::text AS template, p.analog_id AS "analogId",
           p.created_at AS "createdAt",
           EXTRACT(DAY FROM now() - p.created_at)::int AS "daysSince",
           s.impressions
    FROM posts p
    LEFT JOIN LATERAL (
      SELECT impressions FROM metric_snapshots m
      WHERE m.post_id = p.id ORDER BY m.fetched_at DESC LIMIT 1
    ) s ON true
    WHERE p.analog_id IS NOT NULL AND p.is_reply = false
    ORDER BY p.created_at DESC
  `;

  const byConcept = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byConcept.get(r.analogId) ?? [];
    list.push(r);
    byConcept.set(r.analogId, list);
  }

  // Side coverage, computed before scoring so a concept can be told its own
  // door is cold. This is the mismatch the ICP registry cannot express on its
  // own: docs.eco.com's personas are technical integrators, while the analog
  // curriculum is aimed almost entirely at the commercial buyer.
  const sides: ("technical" | "commercial")[] = ["technical", "commercial"];
  const bySide = sides.map((side) => {
    const defs = ANALOG_DEFS.filter((a) => a.side === side);
    return {
      side,
      total: defs.length,
      taught: defs.filter((a) =>
        (byConcept.get(a.id) ?? []).some((m) => TEACHING_PILLARS.has(m.template)),
      ).length,
    };
  });
  const sideRate = new Map(bySide.map((s) => [s.side, s.total === 0 ? 1 : s.taught / s.total]));
  const leanestSide = [...sideRate.entries()].sort((a, b) => a[1] - b[1])[0]?.[0];

  const shelf: CurriculumRow[] = ANALOG_DEFS.map((def: AnalogDef) => {
    const mine = byConcept.get(def.id) ?? [];
    const taughtIn = mine.filter((m) => TEACHING_PILLARS.has(m.template));
    const useCount = taughtIn.length;
    const mentionCount = mine.length - useCount;
    const daysSinceLastUse = taughtIn.length ? Math.min(...taughtIn.map((m) => m.daysSince)) : null;

    const impressions = taughtIn.map((m) => m.impressions).filter((n): n is number => n != null).sort((a, b) => a - b);
    const medianImpr = impressions.length
      ? Math.round(impressions[Math.floor((impressions.length - 1) / 2)])
      : null;

    const { w: cov, why: covWhy } = coverageWeight(useCount, daysSinceLastUse);
    const strength = STRENGTH_WEIGHT[def.breakStrength];

    // The side nudge is small on purpose. It should break ties between equally
    // untaught concepts, never promote a weak concept over a strong one.
    const sideNudge = def.side === leanestSide ? 1.12 : 0.95;

    const srcCount = (sourcesByConcept.get(def.id) ?? []).length;
    const reasons = [covWhy, STRENGTH_REASON[def.breakStrength]];
    if (srcCount === 0) {
      reasons.push("No verified source material yet — run Find sources before drafting");
    }
    if (def.side === leanestSide) {
      const s = bySide.find((b) => b.side === def.side);
      reasons.push(
        `${def.side === "commercial" ? "Commercial" : "Technical"} door is the colder one — ${s?.taught ?? 0} of ${s?.total ?? 0} concepts covered`,
      );
    }
    if (mentionCount > 0) {
      reasons.push(
        `Named in passing ${mentionCount}× outside a teaching pillar — a mention, not a lesson`,
      );
    }
    if (def.guardrail) reasons.push(`Guardrail: ${def.guardrail}`);

    return {
      analogId: def.id,
      label: def.label,
      tier: def.tier,
      side: def.side,
      icps: def.icps,
      icpLabels: def.icps.map((i) => ICP_BY_ID[i]?.label ?? i),
      breakStrength: def.breakStrength,
      parallel: def.parallel,
      breaksWhere: def.breaksWhere,
      guardrail: def.guardrail ?? null,
      sources: sourcesByConcept.get(def.id) ?? [],
      needsSources: (sourcesByConcept.get(def.id) ?? []).length === 0,
      posts: mine.map((m) => ({
        id: m.id,
        url: m.url,
        text: m.text,
        template: m.template,
        createdAt: m.createdAt,
        impressions: m.impressions,
      })),
      useCount,
      mentionCount,
      daysSinceLastUse,
      medianImpr,
      // An unsourced concept is not actually draftable, so it should not head
      // the queue however strong its break is — half weight until it has
      // something citable behind it.
      score: Math.max(
        0,
        Math.min(100, Math.round(100 * cov * strength * sideNudge * (srcCount === 0 ? 0.5 : 1))),
      ),
      reasons,
    };
  }).sort((a, b) => b.score - a.score);

  // An ICP door is cold when NO concept naming it has ever been taught. Cheaper
  // and more honest than a percentage: the operator's real question is "whose
  // door have I never knocked on."
  const touchedIcps = new Set<string>();
  for (const r of shelf) {
    if (r.useCount > 0) r.icps.forEach((i) => touchedIcps.add(i));
  }
  const allIcps = [...new Set(ANALOG_DEFS.flatMap((a) => a.icps))];
  const coldDoors = allIcps
    .filter((i) => !touchedIcps.has(i))
    .map((i) => ICP_BY_ID[i]?.label ?? i)
    .sort();

  return {
    rows: shelf,
    meta: {
      totalConcepts: ANALOG_DEFS.length,
      taught: shelf.filter((r) => r.useCount > 0).length,
      neverTaught: shelf.filter((r) => r.useCount === 0).length,
      unsourced: shelf.filter((r) => r.needsSources).length,
      coldDoors,
      bySide,
    },
  };
}
