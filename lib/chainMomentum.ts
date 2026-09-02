import { xGet, countBilledReads, resolveHandle } from "./twitter.ts";
import { chainLabel } from "./dimensions.ts";
import { CHAIN_ACCOUNTS } from "./chainAccounts.ts";

// Is the timeline paying attention to a chain right now?
//
// The chain pillar has always known when WE last posted about a chain. It has
// never known whether the chain is doing anything worth posting about, and both
// halves are needed to pick a target. Jay, on the 2 Sep call:
//
//   "maybe you have an alert system that's in the app where it's like anytime
//    Base, Unichain, whatever makes a big timeline splash somehow, ping the
//    thing… hey, you haven't posted chain integration in 30 days, and Base just
//    came out with Base AI whatever and they're ripping."
//
// followed immediately by the constraint that shapes the whole design:
//
//   "trying to be careful with overcomplicating your scope."
//
// So: the narrowest thing that answers the question. One read of each watched
// chain's OWN timeline per day, capped. Not mention-volume across all of X,
// which would be a better signal and roughly fifty times the bill.
//
// A spike is judged against that chain's own trailing baseline and never across
// chains. Base's quiet day outperforms most chains' best day, so a cross-chain
// comparison would only ever surface the biggest account — which tells you
// nothing you didn't already know.

/** Posts pulled per chain per run. The cost dial. */
const POSTS_PER_CHAIN = 5;

/** Days of history a spike is measured against. */
const BASELINE_DAYS = 28;

/** Engagement must clear this multiple of the chain's own baseline to be a spike. */
const SPIKE_MULTIPLE = 2;

/**
 * Observed days required in the older window before a ratio is computed at all.
 *
 * This exists because of how the history fills in. Each run reads only the last
 * POSTS_PER_CHAIN posts, so a chain's day rows accumulate one or two at a time
 * and the table is nearly empty for the first fortnight. The first version
 * divided the older window's engagement by a fixed 21 days regardless of how
 * many day rows were actually there — so three observed days of data were
 * averaged as if over twenty-one, the baseline came out ~7x too low, and every
 * chain would have read as spiking on day four. Averaging over observed days
 * fixes the arithmetic; this floor stops a two-day baseline being treated as one
 * at all.
 */
const MIN_BASELINE_DAYS = 7;

type SqlTag = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...params: unknown[]
) => Promise<T[]>;

interface RawTimelineTweet {
  id: string;
  created_at: string;
  text: string;
  public_metrics?: {
    like_count?: number;
    reply_count?: number;
    retweet_count?: number;
    quote_count?: number;
  };
}

// The read counter. lib/twitter.ts's meter is module-global and drained by
// whoever owns the run, so the sweep keeps its own tally of what IT counted.
let localBilled = 0;
function takeBilled(): number {
  const n = localBilled;
  localBilled = 0;
  return n;
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

export interface MomentumSweepResult {
  chains: number;
  days: number;
  reads: number;
  costUsd: number;
  spikes: string[];
  warnings: string[];
}

/**
 * Read each enabled chain's recent posts and roll them up per UTC day.
 *
 * Idempotent per day: re-running replaces that day's row rather than adding to
 * it, so a manual run after the cron does not double the counts.
 */
export async function runMomentumSweep(
  sql: SqlTag,
  opts: { deadline?: number; limitChains?: number } = {},
): Promise<MomentumSweepResult> {
  const warnings: string[] = [];

  // Seed any chain that isn't in the table yet, then read the table — so an
  // operator's enabled/disabled choices survive a deploy.
  for (const a of CHAIN_ACCOUNTS) {
    await sql`
      INSERT INTO chain_momentum_sources (chain, handle, enabled)
      VALUES (${a.chain}, ${a.handle}, ${a.enabled})
      ON CONFLICT (chain) DO UPDATE SET handle = EXCLUDED.handle
    `;
  }

  const sources = await sql<{ chain: string; handle: string; user_id: string | null }>`
    SELECT chain, handle, user_id FROM chain_momentum_sources
    WHERE enabled = true
    ORDER BY last_run ASC NULLS FIRST
  `;
  const todo = opts.limitChains ? sources.slice(0, opts.limitChains) : sources;

  let daysWritten = 0;
  const spikes: string[] = [];

  for (const src of todo) {
    if (opts.deadline && Date.now() > opts.deadline) {
      warnings.push(`stopped early at ${src.chain} — out of time`);
      break;
    }
    try {
      let userId = src.user_id;
      if (!userId) {
        userId = (await resolveHandle(src.handle)).id;
        localBilled += 1; // the user lookup
        await sql`UPDATE chain_momentum_sources SET user_id = ${userId} WHERE chain = ${src.chain}`;
      }

      const data = await xGet<{ data?: RawTimelineTweet[] }>(`/users/${userId}/tweets`, {
        max_results: String(Math.max(5, POSTS_PER_CHAIN)),
        "tweet.fields": "created_at,public_metrics",
        exclude: "retweets,replies",
      });
      const tweets = data.data ?? [];
      // Two counters, on purpose. countBilledReads feeds lib/twitter.ts's global
      // meter (drained by whichever caller owns the run); localBilled is this
      // sweep's own tally, so running inside /api/sync doesn't steal the count
      // from the post ingest that shares the process.
      countBilledReads(tweets.length);
      localBilled += tweets.length;

      // Roll up by UTC day.
      const byDay = new Map<string, { posts: number; likes: number; reposts: number; replies: number; quotes: number; top: RawTimelineTweet | null; topEng: number }>();
      for (const t of tweets) {
        const day = t.created_at.slice(0, 10);
        const m = t.public_metrics ?? {};
        const likes = m.like_count ?? 0;
        const reposts = m.retweet_count ?? 0;
        const replies = m.reply_count ?? 0;
        const quotes = m.quote_count ?? 0;
        const eng = likes + reposts + replies + quotes;
        const cur = byDay.get(day) ?? { posts: 0, likes: 0, reposts: 0, replies: 0, quotes: 0, top: null, topEng: -1 };
        cur.posts++;
        cur.likes += likes;
        cur.reposts += reposts;
        cur.replies += replies;
        cur.quotes += quotes;
        if (eng > cur.topEng) {
          cur.top = t;
          cur.topEng = eng;
        }
        byDay.set(day, cur);
      }

      for (const [day, v] of byDay) {
        await sql`
          INSERT INTO chain_momentum (chain, day, posts, likes, reposts, replies, quotes,
                                      top_post_id, top_post_text, top_post_eng, fetched_at)
          VALUES (${src.chain}, ${day}::date, ${v.posts}, ${v.likes}, ${v.reposts}, ${v.replies}, ${v.quotes},
                  ${v.top?.id ?? null}, ${v.top?.text?.slice(0, 400) ?? null}, ${v.topEng < 0 ? null : v.topEng}, now())
          ON CONFLICT (chain, day) DO UPDATE SET
            posts = EXCLUDED.posts, likes = EXCLUDED.likes, reposts = EXCLUDED.reposts,
            replies = EXCLUDED.replies, quotes = EXCLUDED.quotes,
            top_post_id = EXCLUDED.top_post_id, top_post_text = EXCLUDED.top_post_text,
            top_post_eng = EXCLUDED.top_post_eng, fetched_at = now()
        `;
        daysWritten++;
      }

      await sql`UPDATE chain_momentum_sources SET last_run = now(), last_error = NULL WHERE chain = ${src.chain}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 200) : String(err);
      warnings.push(`${src.chain}: ${msg}`);
      await sql`UPDATE chain_momentum_sources SET last_run = now(), last_error = ${msg} WHERE chain = ${src.chain}`;
    }
  }

  // Which chains are hot after this run — reported so the sync response says
  // something useful rather than only a row count.
  try {
    const hot = await getMomentum(sql);
    for (const m of hot) if (m.spiking) spikes.push(m.label);
  } catch {
    /* reporting only */
  }

  const billed = takeBilled();
  return {
    chains: todo.length,
    days: daysWritten,
    reads: billed,
    costUsd: billed * Number(process.env.X_API_COST_PER_READ_USD || 0.005),
    spikes,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

export interface ChainMomentum {
  chain: string;
  label: string;
  /** Engagement over the last 7 days. */
  recentEng: number;
  /**
   * Mean engagement per OBSERVED day in the trailing window, excluding the last
   * 7. Null until MIN_BASELINE_DAYS of history exist — which on a fresh install
   * means this whole column reads "—" for the first week or so while the daily
   * cron fills the table in.
   */
  baselineEng: number | null;
  /** Recent engagement per observed day ÷ baselineEng. Null when there's no baseline yet. */
  ratio: number | null;
  /** Observed day rows behind the baseline, so the UI can say why a ratio is absent. */
  baselineDays: number;
  spiking: boolean;
  postsRecent: number;
  lastDay: string | null;
  topPostId: string | null;
  topPostText: string | null;
  topPostEng: number | null;
  /** Days since @eco last posted about this chain, ANY pillar. Null = never. */
  ecoCoverDaysSince: number | null;
  ecoCoverTemplate: string | null;
  /** Eco is live on this chain. Drives the "you should be posting this" nudge. */
  integrated: boolean;
  /** Per-day engagement, oldest first — the sparkline. */
  series: { day: string; eng: number; posts: number }[];
}

export async function getMomentum(sql: SqlTag): Promise<ChainMomentum[]> {
  const rows = await sql<{
    chain: string;
    day: string;
    posts: number;
    eng: number;
    topPostId: string | null;
    topPostText: string | null;
    topPostEng: number | null;
  }>`
    SELECT chain, to_char(day, 'YYYY-MM-DD') AS day, posts,
           (likes + reposts + replies + quotes) AS eng,
           top_post_id AS "topPostId", top_post_text AS "topPostText", top_post_eng AS "topPostEng"
    FROM chain_momentum
    WHERE day >= (now() - (${BASELINE_DAYS} || ' days')::interval)::date
    ORDER BY chain, day ASC
  `;

  // What Eco has said about each chain lately, any pillar — so the tab can pair
  // "this chain is hot" with "and you haven't mentioned it in five weeks",
  // which is the only combination that is actually a call to action.
  const coverRows = await sql<{ chain: string; daysSince: number; lastTemplate: string }>`
    WITH exploded AS (
      SELECT unnest(chains) AS chain, template::text AS template, created_at
      FROM posts WHERE is_reply = false AND template IS NOT NULL
    ),
    ranked AS (
      SELECT chain, template, created_at,
             ROW_NUMBER() OVER (PARTITION BY chain ORDER BY created_at DESC) AS rn,
             MAX(created_at) OVER (PARTITION BY chain) AS last_posted
      FROM exploded
    )
    SELECT chain, EXTRACT(DAY FROM now() - last_posted)::int AS "daysSince", template AS "lastTemplate"
    FROM ranked WHERE rn = 1
  `;
  const coverByChain = new Map(coverRows.map((r) => [r.chain, r]));

  const integratedRows = await sql<{ chain: string }>`
    SELECT chain FROM articles WHERE chain IS NOT NULL AND kind = 'chain_integration'
    UNION
    SELECT unnest(chains) FROM posts WHERE template = 'integration_announcement' AND is_reply = false
  `;
  const integrated = new Set(integratedRows.map((r) => r.chain));

  const byChain = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byChain.get(r.chain) ?? ([] as unknown as typeof rows);
    list.push(r);
    byChain.set(r.chain, list);
  }

  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

  const out: ChainMomentum[] = [];
  for (const [chain, days] of byChain) {
    const recent = days.filter((d) => d.day >= cutoff);
    const older = days.filter((d) => d.day < cutoff);
    const recentEng = recent.reduce((a, d) => a + Number(d.eng), 0);
    // Averaged over the days we actually HAVE, in both windows. A chain whose
    // account went quiet for four days genuinely averaged less over the week;
    // a chain we have only observed for four days has no seven-day average to
    // report, and saying so is the only honest option.
    const baselineEng =
      older.length >= MIN_BASELINE_DAYS
        ? older.reduce((a, d) => a + Number(d.eng), 0) / older.length
        : null;
    const recentPerDay = recent.length ? recentEng / recent.length : 0;
    const ratio = baselineEng && baselineEng > 0 ? recentPerDay / baselineEng : null;
    const top = recent.reduce<(typeof rows)[number] | null>(
      (best, d) => ((d.topPostEng ?? -1) > (best?.topPostEng ?? -1) ? d : best),
      null,
    );
    const cov = coverByChain.get(chain);
    out.push({
      chain,
      label: chainLabel(chain),
      recentEng,
      baselineEng: baselineEng == null ? null : Math.round(baselineEng),
      ratio: ratio == null ? null : Math.round(ratio * 100) / 100,
      baselineDays: older.length,
      spiking: ratio != null && ratio >= SPIKE_MULTIPLE,
      postsRecent: recent.reduce((a, d) => a + Number(d.posts), 0),
      lastDay: days.at(-1)?.day ?? null,
      topPostId: top?.topPostId ?? null,
      topPostText: top?.topPostText ?? null,
      topPostEng: top?.topPostEng ?? null,
      ecoCoverDaysSince: cov?.daysSince ?? null,
      ecoCoverTemplate: cov?.lastTemplate ?? null,
      integrated: integrated.has(chain),
      series: days.map((d) => ({ day: d.day, eng: Number(d.eng), posts: Number(d.posts) })),
    });
  }

  // Spiking first, then by how far above their own baseline they are. Within
  // the spikes, the ones Eco has gone quiet on come first — that is the actual
  // to-do list.
  return out.sort((a, b) => {
    if (a.spiking !== b.spiking) return a.spiking ? -1 : 1;
    if (a.spiking && b.spiking) {
      const aQuiet = a.ecoCoverDaysSince ?? 9999;
      const bQuiet = b.ecoCoverDaysSince ?? 9999;
      if (aQuiet !== bQuiet) return bQuiet - aQuiet;
    }
    return (b.ratio ?? 0) - (a.ratio ?? 0);
  });
}

export { SPIKE_MULTIPLE, BASELINE_DAYS, POSTS_PER_CHAIN, MIN_BASELINE_DAYS };
