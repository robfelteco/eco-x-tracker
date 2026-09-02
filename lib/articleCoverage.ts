import type { Template } from "./taxonomy.ts";
import { TEMPLATE_BY_ID } from "./taxonomy.ts";

// The PAIRING clock: when was this piece last in front of the audience, by any
// pillar at all?
//
// The problem it solves, in the shape it actually arrived in. On the morning of
// 2 Sep the board read "New Chain Integrations — way overdue, score 90". The
// most recent post in the feed was a data-motion visual quote-posting the
// Robinhood chain integration article. Both statements were true of what they
// measured: no post had been FILED under integration_announcement in weeks, and
// the Robinhood piece had been amplified that morning. The pillar clock could
// only see the first one.
//
// There is already a cross-pillar clock for chains (`cover*` on ChainAngle,
// grouped by posts.chains), and it is not the same thing. A chain tag says the
// post mentioned the chain — true of any market-data visual naming @base. An
// ARTICLE link says the post ran our piece about it, which is what makes the
// standalone announcement redundant for a while. Rob's read on the call was the
// tighter one and it is the one implemented here: score off the shared article,
// not the shared chain.
//
// Nothing here is a chain concept. A quote card that quote-posts a product
// piece cools that product's shelf by the same rule, which is the answer to
// "what about other edge cases like quote cards too".

export interface ArticleCoverage {
  articleId: number;
  /** Posts amplifying this article, any pillar. */
  count: number;
  lastPosted: string | null;
  daysSince: number | null;
  /** The pillar whose post ran it most recently. */
  lastTemplate: Template;
  lastLabel: string;
  lastPostId: string | null;
  lastPostUrl: string | null;
}

type SqlTag = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...params: unknown[]
) => Promise<T[]>;

/**
 * One row per article that any post has amplified, keyed by article id.
 *
 * Deliberately NOT filtered by the caller's amplified/since filter. The
 * question is "has the audience seen this piece lately", and a paid-amplified
 * post or one outside the operator's chosen date window still put it in front
 * of them. Filtering here would make the pairing signal disappear whenever
 * someone narrowed the view, which is the opposite of the point.
 */
export async function getArticleCoverage(sql: SqlTag): Promise<Map<number, ArticleCoverage>> {
  const rows = await sql<{
    articleId: number;
    count: number;
    lastPosted: string | null;
    daysSince: number | null;
    lastTemplate: Template;
    lastPostId: string | null;
    lastPostUrl: string | null;
  }>`
    WITH scoped AS (
      SELECT p.id, p.url, p.article_id, p.template, p.created_at
      FROM posts p
      WHERE p.article_id IS NOT NULL
        AND p.template IS NOT NULL
        AND p.is_reply = false
    ),
    ranked AS (
      SELECT article_id, template, created_at, id, url,
             ROW_NUMBER() OVER (PARTITION BY article_id ORDER BY created_at DESC) AS rn,
             COUNT(*)        OVER (PARTITION BY article_id) AS n,
             MAX(created_at) OVER (PARTITION BY article_id) AS last_posted
      FROM scoped
    )
    SELECT article_id::int AS "articleId",
           n::int          AS count,
           last_posted     AS "lastPosted",
           EXTRACT(DAY FROM now() - last_posted)::int AS "daysSince",
           template        AS "lastTemplate",
           id              AS "lastPostId",
           url             AS "lastPostUrl"
    FROM ranked WHERE rn = 1
  `;
  return new Map(
    rows.map((r) => [
      Number(r.articleId),
      {
        articleId: Number(r.articleId),
        count: r.count,
        lastPosted: r.lastPosted,
        daysSince: r.daysSince,
        lastTemplate: r.lastTemplate,
        lastLabel: TEMPLATE_BY_ID[r.lastTemplate]?.label ?? r.lastTemplate,
        lastPostId: r.lastPostId,
        lastPostUrl: r.lastPostUrl,
      },
    ]),
  );
}

// ---------------------------------------------------------------------------
// The discount
// ---------------------------------------------------------------------------

/** One draft target of a pillar, reduced to the only two things this needs. */
export interface PairableTarget {
  label: string;
  articleId: number | null;
}

export interface PairingVerdict {
  /** Multiply the pillar's score by this. 1 = untouched. */
  multiplier: number;
  /** Plain-English driver, appended to the score's reasons. Null when 1. */
  reason: string | null;
  /** Days since the freshest cross-pillar amplification, for the UI. */
  freshestDaysSince: number | null;
  /** How many of the pillar's article-backed targets are covered right now. */
  covered: number;
  eligible: number;
}

const NEUTRAL: PairingVerdict = {
  multiplier: 1,
  reason: null,
  freshestDaysSince: null,
  covered: 0,
  eligible: 0,
};

/**
 * How much to cool a pillar whose own source material has just been run by a
 * different pillar.
 *
 * The shape is a discount, not a mute, and that is the deliberate half. The
 * standalone gap is real: a data-motion visual quoting the Robinhood piece is
 * not an "Eco is live on Robinhood Chain" post, and a pillar that never gets
 * its own post is a pillar that quietly stops existing. What the call actually
 * asked for was that it "not be prioritized so high" — so the pillar drops down
 * the board and says why, rather than vanishing off it.
 *
 * Scaled by how MUCH of the pillar's shelf is covered, because covering one
 * chain article out of six leaves five cold angles and should barely move the
 * number, while covering the only piece a pillar has is the whole pillar.
 */
export function pairingVerdict(
  template: Template,
  targets: PairableTarget[],
  coverage: Map<number, ArticleCoverage>,
): PairingVerdict {
  const staleDays = TEMPLATE_BY_ID[template].staleDays;
  const eligible = targets.filter((t) => t.articleId != null);
  if (!eligible.length) return NEUTRAL;

  // A target is "covered" when its article was amplified inside this pillar's
  // own cadence window BY A DIFFERENT PILLAR. Same-pillar amplification is
  // already what the pillar clock measures; counting it here would discount the
  // pillar twice for one post.
  const hits = eligible
    .map((t) => ({ target: t, cov: coverage.get(t.articleId as number) }))
    .filter(
      (x): x is { target: PairableTarget; cov: ArticleCoverage } =>
        x.cov != null &&
        x.cov.daysSince != null &&
        x.cov.daysSince <= staleDays &&
        x.cov.lastTemplate !== template,
    );
  if (!hits.length) return NEUTRAL;

  const freshest = hits.reduce((a, b) => ((b.cov.daysSince as number) < (a.cov.daysSince as number) ? b : a));
  const frac = hits.length / eligible.length;

  // How recent the freshest pairing is decides the ceiling; how much of the
  // shelf it covers decides how far toward that ceiling we go.
  const freshestDays = freshest.cov.daysSince as number;
  const ceiling = freshestDays <= staleDays * 0.6 ? 0.45 : 0.75;
  const multiplier = Math.round((1 - (1 - ceiling) * frac) * 100) / 100;

  const ago = freshestDays <= 0 ? "today" : `${freshestDays}d ago`;
  const scope =
    eligible.length === 1
      ? `its source piece`
      : `${hits.length} of ${eligible.length} source pieces`;
  const reason =
    `Cooled — ${scope} already ran in another pillar (${freshest.target.label} ${ago}, ` +
    `${freshest.cov.lastLabel}). The standalone post is still owed.`;

  return {
    multiplier,
    reason,
    freshestDaysSince: freshestDays,
    covered: hits.length,
    eligible: eligible.length,
  };
}
