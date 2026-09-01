// Recency discipline. The companion to antiSlop.ts, same three-stage shape:
// facts into the prompt, rules in the prompt, a check in code on what came back.
//
// Why this exists. The drafter has no clock. It was handed a source with a
// "Published: 2026-06-17" line and nothing to compare it against, so "just
// published" was never a lie it told on purpose, it was the only register it
// had for a piece it was told to argue from. A draft on the ESM AI blog opened
// "The ESM just published data showing..." eleven weeks after publication, and
// the figure in question was not even the blog's own: the post footnoted it to
// the ESM's November 2024 piece. Two separate false timestamps in one clause.
//
// Both failures are mechanical, so both are handled here:
//
//   1. recencyBlock()  puts today's date, every source date, and the computed
//      age in days into the prompt. A model that can subtract does not need to
//      be told 76 days is not "just".
//   2. scanRecency()   checks the returned draft against those same dates, per
//      claim, and per the precision of the date backing it. A source dated only
//      "2026" cannot support "this week" no matter how recent 2026 is.
//
// Old material is not the problem and is never flagged here. Arguing from a
// 2019 BIS paper is the curriculum pillar working as designed. Dressing it as
// news is the problem.

import type { SlopFinding } from "./antiSlop.ts";

const DAY_MS = 86_400_000;

export type DatePrecision = "day" | "month" | "year";

const PRECISION_RANK: Record<DatePrecision, number> = { year: 0, month: 1, day: 2 };

export interface RecencySource {
  /** How the source is named back to the operator in a finding. */
  label: string;
  /** Raw as stored: analog_sources allows YYYY, YYYY-MM or YYYY-MM-DD. */
  publishedOn: string | null;
  /** Set when the source has a URL, so a finding can be tied to the cited one. */
  url?: string | null;
  /**
   * Days between publication and today, or null when undated. Computed from the
   * LATEST date the string could mean: "2026" is read as 2026-12-31, not
   * 2026-01-01. The generous reading keeps the scan from inventing staleness
   * the data does not prove, and the precision field carries the uncertainty
   * instead of the age doing it badly.
   */
  ageDays: number | null;
  precision: DatePrecision | null;
}

export interface RecencyContext {
  /** YYYY-MM-DD, the day the draft is being written. */
  today: string;
  sources: RecencySource[];
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function parsePublished(raw: string | null | undefined): { latest: Date; precision: DatePrecision } | null {
  if (!raw) return null;
  const m = String(raw).trim().match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (!m) return null;
  const y = Number(m[1]);
  if (y < 1900 || y > 2200) return null;

  if (m[3] && m[2]) {
    return { latest: new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[3]))), precision: "day" };
  }
  if (m[2]) {
    // Day 0 of the next month is the last day of this one.
    return { latest: new Date(Date.UTC(y, Number(m[2]), 0)), precision: "month" };
  }
  return { latest: new Date(Date.UTC(y, 11, 31)), precision: "year" };
}

/** Today as YYYY-MM-DD, UTC. One helper so the whole module shares a clock. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function buildSource(
  label: string,
  publishedOn: string | null | undefined,
  url?: string | null,
  now: Date = new Date(),
): RecencySource {
  const parsed = parsePublished(publishedOn);
  if (!parsed) return { label, publishedOn: publishedOn ?? null, url: url ?? null, ageDays: null, precision: null };
  // A source dated in the future is a data-entry error, not a scoop. Clamp to 0
  // so it reads as "as fresh as it gets" rather than a negative age.
  const ageDays = Math.max(0, Math.floor((now.getTime() - parsed.latest.getTime()) / DAY_MS));
  return { label, publishedOn: publishedOn ?? null, url: url ?? null, ageDays, precision: parsed.precision };
}

function agePhrase(s: RecencySource): string {
  if (s.ageDays === null) return "no date on file";
  if (s.ageDays <= 1) return "1 day old or less";
  if (s.ageDays < 60) return `${s.ageDays} days old`;
  if (s.ageDays < 730) {
    const months = Math.round(s.ageDays / 30.4);
    return `${s.ageDays} days old, about ${months} month${months === 1 ? "" : "s"}`;
  }
  // Past two years, days stop meaning anything to a reader. "2738 days old,
  // about 90 months" is technically correct and completely unreadable.
  const years = Math.round((s.ageDays / 365.25) * 10) / 10;
  return `about ${years} years old`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * The date phrasing a draft could honestly use instead, at whatever precision
 * the source actually has. Written into the finding so the repair pass gets a
 * true replacement rather than only being told what to delete.
 */
function honestDateWord(s: RecencySource): string | null {
  if (!s.publishedOn) return null;
  const m = s.publishedOn.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (!m) return null;
  const year = m[1];
  if (!m[2]) return `in ${year}`;
  const month = MONTHS[Number(m[2]) - 1] ?? "";
  if (!month) return `in ${year}`;
  return m[3] ? `in ${month} ${year}` : `in ${month} ${year}`;
}

function precisionNote(s: RecencySource): string {
  if (s.precision === "month") return ", month precision only";
  if (s.precision === "year") return ", year precision only";
  return "";
}

// ---------------------------------------------------------------------------
// The claims. Each tier is a promise about WHEN, and each promise needs a
// source date recent enough and precise enough to keep it.
// ---------------------------------------------------------------------------

interface RecencyRule {
  rule: string;
  severity: "hard" | "soft";
  re: RegExp;
  /** The oldest source, in days, that can still back this phrasing. */
  maxAgeDays: number;
  /** The coarsest source date that can back it. */
  needs: DatePrecision;
  /** What the phrasing promises, written into the finding. */
  promises: string;
}

const RULES: RecencyRule[] = [
  {
    rule: "false-recency",
    severity: "hard",
    // The breaking-news register. "just published" is the exact construction
    // that started this.
    re: /\bjust\s+(?:published|released|announced|dropped|out|landed|posted|reported|put\s+out|came\s+out)\b|\bbreaking\s*[:,]|\bbreaking\s+news\b|\bhot\s+off\b|\b(?:moments|minutes|hours)\s+ago\b|\bas\s+of\s+(?:today|this\s+morning)\b|\b(?:published|released|announced|reported|posted|dropped|out)\s+(?:today|yesterday|this\s+morning)\b|\btoday'?s\s+(?:report|data|figures|numbers|release|announcement|paper|note)\b/gi,
    maxAgeDays: 3,
    needs: "day",
    promises: "that this landed in the last day or two",
  },
  {
    rule: "false-recency",
    severity: "hard",
    re: /\bthis\s+week\b|\bearlier\s+this\s+week\b|\blast\s+week\b|\b(?:a\s+few|several)\s+days\s+ago\b|\bfresh\s+(?:data|figures|numbers)\b|\bbrand\s+new\b/gi,
    maxAgeDays: 14,
    needs: "day",
    promises: "that this is days old",
  },
  {
    rule: "false-recency",
    severity: "hard",
    re: /\bnew\s+(?:data|figures|numbers|report|study|paper|research|survey)\b|\bnewly\s+(?:published|released)\b|\b(?:just|only)\s+(?:weeks|days)\s+ago\b|\bthis\s+month\b|\blast\s+month\b/gi,
    maxAgeDays: 60,
    needs: "month",
    promises: "that this is the current release",
  },
  {
    rule: "stale-recency",
    severity: "soft",
    // "recently" and "latest" are defensible on older material: the latest
    // figures really can be two years old if nobody has published since. Soft,
    // so the operator sees it without a repair round-trip being spent on it.
    re: /\brecent(?:ly)?\b|\bthe\s+latest\s+(?:data|figures|numbers|report|release)\b|\bup-?to-?date\s+(?:data|figures|numbers)\b/gi,
    maxAgeDays: 400,
    needs: "year",
    promises: "recency in general terms",
  },
];

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/**
 * Pick the source a finding should be judged against.
 *
 * On the pinned path there is exactly one. On the blended path the model chose,
 * and the choice comes back as sourceUrl, so judge against what it actually
 * cited. With no usable match, judge against the FRESHEST dated source: the
 * draft gets the benefit of the doubt, and a flag that survives that is real.
 */
function judgeAgainst(ctx: RecencyContext, citedUrl?: string | null): RecencySource | null {
  if (!ctx.sources.length) return null;
  if (citedUrl) {
    const hit = ctx.sources.find((s) => s.url && s.url === citedUrl);
    if (hit) return hit;
  }
  const dated = ctx.sources.filter((s) => s.ageDays !== null);
  if (!dated.length) return ctx.sources[0] ?? null;
  return dated.reduce((best, s) => ((s.ageDays as number) < (best.ageDays as number) ? s : best));
}

export function scanRecency(text: string, ctx: RecencyContext, citedUrl?: string | null): SlopFinding[] {
  const out: SlopFinding[] = [];
  if (!text || !ctx.sources.length) return out;

  const src = judgeAgainst(ctx, citedUrl);
  if (!src) return out;

  for (const r of RULES) {
    const hits = text.match(r.re) ?? [];
    if (!hits.length) continue;
    const match = (hits[0] ?? "").trim().slice(0, 60);

    // Undated source: nothing here can back a claim about when.
    if (src.ageDays === null || src.precision === null) {
      out.push({
        rule: r.rule,
        severity: r.severity,
        match,
        fix:
          `"${match}" claims ${r.promises}, and ${src.label} has no publication date on file, ` +
          `so nothing supports it. Drop the timestamp and let the claim stand on the fact.`,
      });
      continue;
    }

    const tooOld = src.ageDays > r.maxAgeDays;
    const tooVague = PRECISION_RANK[src.precision] < PRECISION_RANK[r.needs];
    if (!tooOld && !tooVague) continue;

    out.push({
      rule: r.rule,
      severity: r.severity,
      match,
      fix: tooOld
        ? `"${match}" claims ${r.promises}, but ${src.label} is ${agePhrase(src)} (${src.publishedOn}). ` +
          `Cut the recency claim` +
          (honestDateWord(src) ? `, or name the real date: "${honestDateWord(src)}" is true where "${match}" is not.` : ` and let the fact carry the sentence.`)
        : `"${match}" claims ${r.promises}, but ${src.label} is dated only "${src.publishedOn}"${precisionNote(src)}, ` +
          `which cannot support a claim that precise. Drop the timestamp or write the date you actually have.`,
    });
  }

  // One finding per rule id, matching scanSlop's behaviour: three flavours of
  // the same mistake is still one thing to fix.
  return out.filter((f, i) => out.findIndex((x) => x.rule === f.rule) === i);
}

// ---------------------------------------------------------------------------
// The prompt block
// ---------------------------------------------------------------------------

/**
 * The facts and the rules, handed over together. Returns null when the call has
 * no dated material at all, in which case there is nothing to anchor to and the
 * scan does the work alone.
 */
export function recencyBlock(ctx: RecencyContext): string | null {
  if (!ctx.sources.length) return null;

  return [
    `TODAY IS ${ctx.today}. You have no clock of your own, so every claim you make about`,
    `WHEN something happened is checked in code against the dates below after you return.`,
    ``,
    `SOURCE DATES:`,
    ...ctx.sources.map((s) => {
      const d = s.publishedOn ? `published ${s.publishedOn}${precisionNote(s)}, ${agePhrase(s)}` : `NO PUBLICATION DATE ON FILE`;
      return `  ${s.label}: ${d}`;
    }),
    ``,
    `RECENCY RULES:`,
    `  * Using older material is fine and often better. A 2019 paper that explains the`,
    `    mechanism correctly beats a fresh piece that does not. Age is never the problem.`,
    `    Dressing age as news is, and it is the one error a reader can catch in one click.`,
    `  * Do not write "just published", "just released", "breaking", "this week", "new data",`,
    `    "today's figures" or any equivalent unless a date above actually carries it. Subtract`,
    `    first. Anything past a couple of days is not "just".`,
    `  * A source dated only by year or month cannot back a day-level claim. "2026-06" supports`,
    `    "in June", never "this week".`,
    `  * THE PUBLICATION DATE IS NOT THE DATA'S DATE. A recent piece routinely restates an`,
    `    older figure, and the figure keeps its own vintage. If the source attributes a number`,
    `    to an earlier report, footnote or dataset, either say where the number came from or`,
    `    leave the vintage out. Never let the piece's date rub off on a number it borrowed.`,
    `  * Do not imply a source published something for the first time. "The ESM put a number`,
    `    on this" is safe; "the ESM just published data showing" asserts a date and an origin,`,
    `    and both can be wrong at once.`,
    `  * When the hook you want needs a freshness the dates do not support, drop the hook. The`,
    `    claim itself is what earns the reply, and a wrong timestamp is the cheapest possible`,
    `    thing to get caught on.`,
  ].join("\n");
}
