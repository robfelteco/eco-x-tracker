import { CHAIN_LABELS } from "./dimensions.ts";

// Which chains Eco is actually LIVE on — one definition, read by every caller
// that splits "we route through this chain" from "we don't yet".
//
// It used to be two copies of the same UNION query, in lib/dmvLanes.ts and
// lib/chainMomentum.ts, and both were wrong in the same way: they inferred
// integration from PUBLISHING. A chain counted as integrated once it had a
// chain-integration article or a post filed under New Chain Integrations, so
// Arbitrum, Base and Ethereum — three chains the Portal has routed through
// since launch — sat in the "non-integrated" data lane, captioned "Eco isn't
// live here yet", because marketing never shipped a dedicated blog post for
// them. The lane hint then told the operator to write no Eco CTA on exactly
// the chains that can carry one.
//
// So the derivation stays (it is what keeps the set from drifting as new
// integrations ship) and gains a third source: an explicit registry of chains
// that are live with no dedicated piece behind them. Being live on a chain is
// a fact about the product, not about the content calendar, and this is the one
// place that distinction is allowed to be stated by hand.

/**
 * Live in the Portal, no dedicated blog post. Each entry needs a reason —
 * this list is a claim about the product, and an unexplained line here is
 * indistinguishable from a mistake.
 *
 * Remove an entry once a piece for it is seeded: the article path picks it up
 * and a second source would just be a duplicate. Arbitrum is not listed here
 * for that reason — eco.com/blog/arbitrum-leads-usage-across-eco is in
 * scripts/ingest-chain-articles.ts and marks it integrated on its own.
 */
export const LIVE_WITHOUT_ARTICLE: Record<string, string> = {
  base: "Routed through since Portal launch; never had a dedicated integration post.",
  ethereum: "Origin chain for Routes; never had a dedicated integration post.",
};

// A typo here would silently mark a chain that does not exist as integrated,
// which is invisible — the chain simply never appears in any lane.
for (const chain of Object.keys(LIVE_WITHOUT_ARTICLE)) {
  if (!CHAIN_LABELS[chain]) {
    throw new Error(`LIVE_WITHOUT_ARTICLE: "${chain}" is not a chain id in lib/dimensions.ts`);
  }
}

type SqlTag = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...params: unknown[]
) => Promise<T[]>;

/**
 * The set of chain ids Eco is live on: seeded integration articles, plus posts
 * filed under the integration pillar, plus the registry above.
 */
export async function getIntegratedChains(sql: SqlTag): Promise<Set<string>> {
  const rows = await sql<{ chain: string }>`
    SELECT chain FROM articles WHERE chain IS NOT NULL AND kind = 'chain_integration'
    UNION
    SELECT unnest(chains) AS chain FROM posts
      WHERE template = 'integration_announcement' AND is_reply = false
  `;
  return new Set([...rows.map((r) => r.chain), ...Object.keys(LIVE_WITHOUT_ARTICLE)]);
}
