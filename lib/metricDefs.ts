// Single source of truth for what every column/metric on the dashboard MEANS.
// Jay's QA note: the numbers need to explain themselves. He specifically hit
// "what does 90-day post mean?" — it's a cadence count, not a performance stat,
// and the tooltip now says so. Reuse these on every page that shows a metric.

export const METRIC_DEFS = {
  daysSince: "Days since this pillar was last posted. Colored against the pillar's own cadence threshold — green ok, amber warming, red overdue.",
  count30: "How many posts in this pillar went out in the last 30 days. A cadence count, not a performance number.",
  count90: "How many posts in this pillar went out in the last 90 days. A cadence count, not a performance number.",
  medianImpr: "Median impressions across this pillar's posts (each post's latest metric snapshot). Median, not average, so one viral or boosted post can't skew it.",
  avgImpr: "Average impressions across this pillar's posts.",
  avgEng: "Average engagement rate: (likes + replies + reposts + quotes + bookmarks) ÷ impressions, averaged over the pillar's posts.",
  score: "Priority score 0–100: how overdue this pillar is (vs its cadence) blended with how well it performs against the other pillars. Freshly-posted pillars score 0 and rest.",
  baseline: "Clean performance baseline — organic posts only, with the pillar's boosted launch post excluded — so a manufactured-success spike doesn't set the bar.",
  bestAngle: "Within this pillar, the chain angle with the strongest median impressions that you haven't just posted. 'You did Solana — the next best untapped angle is Arbitrum.'",
  reAmplify: "Past top-performing posts old enough to run again without looking repetitive.",
} as const;
