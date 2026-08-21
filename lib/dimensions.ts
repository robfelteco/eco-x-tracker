// Post sub-dimensions: which CHAIN(s) and which COMPANY/entity a post highlights.
// This is the axis Jay wants the Insights tab to rank on — "the highest-ranking
// data motion visual based on the chain and the company we're highlighting" —
// and it lives almost entirely in @-mentions (@solana, @trondao, @Visa,
// @DoorDash…), with outbound domains and a few distinctive text tokens as
// backup. Extraction is deterministic and cheap; it runs at ingest (no Claude).
//
// Kept dependency-free so both lib/ingest.ts (TS) and the backfill script can
// import it. Extend the maps as new chains/partners show up in the feed.

export interface DimensionInput {
  text: string;
  mentions: string[]; // @handles, lowercased, no leading @
  domains: string[]; // outbound domains, lowercased
}

export interface Dimensions {
  chains: string[]; // canonical chain ids, sorted, deduped
  entities: string[]; // canonical company/partner ids, sorted, deduped
}

// --- CHAINS ---------------------------------------------------------------
// @handle → canonical chain id. The most reliable signal.
const CHAIN_HANDLES: Record<string, string> = {
  ethereum: "ethereum",
  solana: "solana",
  polygon: "polygon",
  "0xpolygon": "polygon",
  trondao: "tron",
  bnbchain: "bnb",
  binancechain: "bnb",
  base: "base",
  arbitrum: "arbitrum",
  optimism: "optimism",
  optimismfnd: "optimism",
  avax: "avalanche",
  avalancheavax: "avalanche",
  hyperliquidx: "hyperliquid",
  robinhoodcrypto: "robinhood",
  tempo: "tempo",
  plasma: "plasma",
  sei: "sei",
  seinetwork: "sei",
  suinetwork: "sui",
  aptos: "aptos",
  aptoslabs: "aptos",
  ton_blockchain: "ton",
  the_open_network: "ton",
  celo: "celo",
  stellarorg: "stellar",
  ripple: "xrpl",
  nearprotocol: "near",
  zksync: "zksync",
  starknet: "starknet",
  unichain: "unichain",
  monad_xyz: "monad",
  berachain: "berachain",
};

// Distinctive text tokens → chain. Only unambiguous crypto-specific names.
// Generic words that ALSO mean something in ordinary English are intentionally
// NOT here — they'd tag posts that never mention the chain. The @handle map
// above is the reliable signal for those. Excluded on purpose:
//   base, tempo, ton, sei, op            — short generic words
//   stellar, optimism, avalanche         — common English adjectives/nouns.
//     ("stellar growth", "cautious optimism", "an avalanche of…") — these were
//     the source of the phantom "Stellar" chip Jay flagged: a Western Union /
//     SoFi / MoneyGram post got tagged Stellar purely for the word "stellar".
//   celo, monad                          — real words / names in other contexts.
// Every excluded chain is still detected whenever its @handle is mentioned.
const CHAIN_KEYWORDS: Record<string, string[]> = {
  ethereum: ["ethereum"],
  solana: ["solana"],
  polygon: ["polygon"],
  tron: ["tron"],
  bnb: ["bnb chain", "bnbchain"],
  arbitrum: ["arbitrum"],
  hyperliquid: ["hyperliquid"],
  aptos: ["aptos"],
  zksync: ["zksync"],
  starknet: ["starknet"],
  berachain: ["berachain"],
};

export const CHAIN_LABELS: Record<string, string> = {
  ethereum: "Ethereum",
  solana: "Solana",
  polygon: "Polygon",
  tron: "Tron",
  bnb: "BNB Chain",
  base: "Base",
  arbitrum: "Arbitrum",
  optimism: "Optimism",
  avalanche: "Avalanche",
  hyperliquid: "Hyperliquid",
  robinhood: "Robinhood Chain",
  tempo: "Tempo",
  plasma: "Plasma",
  sei: "Sei",
  sui: "Sui",
  aptos: "Aptos",
  ton: "TON",
  celo: "Celo",
  stellar: "Stellar",
  xrpl: "XRPL",
  near: "NEAR",
  zksync: "zkSync",
  starknet: "Starknet",
  unichain: "Unichain",
  monad: "Monad",
  berachain: "Berachain",
};

// --- ENTITIES (companies / issuers / partners we highlight) ---------------
const ENTITY_HANDLES: Record<string, string> = {
  circle: "circle",
  tether_to: "tether",
  tether: "tether",
  paxos: "paxos",
  stripe: "stripe",
  visa: "visa",
  mastercard: "mastercard",
  paypal: "paypal",
  moneygram: "moneygram",
  doordash: "doordash",
  revolut: "revolut",
  binance: "binance",
  binanceresearch: "binance",
  coinbase: "coinbase",
  robinhoodcrypto: "robinhood",
  citi: "citi",
  citigroup: "citi",
  fireblocks: "fireblocks",
  zerohash: "zerohash",
  getpara: "para",
  stablecoin: "bridge", // @stablecoin is Bridge (bridge.xyz)
  bridge_xyz: "bridge",
  lifi: "lifi",
  galaxyhq: "galaxy",
  nubank: "nubank",
  grab: "grab",
  mercadolibre: "mercadolibre",
  worldpay: "worldpay",
  sphere: "sphere",
};

// Outbound domain → entity. A post linking circle.com is about Circle even if
// the handle isn't @-mentioned.
const ENTITY_DOMAINS: Record<string, string> = {
  "circle.com": "circle",
  "stripe.com": "stripe",
  "citigroup.com": "citi",
  "fireblocks.com": "fireblocks",
  "zerohash.com": "zerohash",
  "galaxy.com": "galaxy",
  "getpara.com": "para",
  "blog.getpara.com": "para",
  "li.fi": "lifi",
  "tempo.xyz": "tempo", // tempo is both a chain and the company
};

export const ENTITY_LABELS: Record<string, string> = {
  circle: "Circle",
  tether: "Tether",
  paxos: "Paxos",
  stripe: "Stripe",
  visa: "Visa",
  mastercard: "Mastercard",
  paypal: "PayPal",
  moneygram: "MoneyGram",
  doordash: "DoorDash",
  revolut: "Revolut",
  binance: "Binance",
  coinbase: "Coinbase",
  robinhood: "Robinhood",
  citi: "Citi",
  fireblocks: "Fireblocks",
  zerohash: "Zero Hash",
  para: "Para",
  bridge: "Bridge",
  lifi: "LI.FI",
  galaxy: "Galaxy",
  nubank: "Nubank",
  grab: "Grab",
  mercadolibre: "MercadoLibre",
  worldpay: "Worldpay",
  sphere: "Sphere",
  tempo: "Tempo",
};

// Word-boundary keyword test that treats [a-z0-9] as "word" chars so "base" in
// "database" never matches. Handles multi-word tokens ("bnb chain") too.
function hasToken(haystack: string, token: string): boolean {
  const t = token.toLowerCase();
  const i = haystack.indexOf(t);
  if (i === -1) return false;
  const before = haystack[i - 1];
  const after = haystack[i + t.length];
  const wordish = (c: string | undefined) => !!c && /[a-z0-9]/.test(c);
  return !wordish(before) && !wordish(after);
}

export function extractDimensions(input: DimensionInput): Dimensions {
  const text = (input.text || "").toLowerCase();
  const mentions = (input.mentions || []).map((m) => m.toLowerCase());
  const domains = (input.domains || []).map((d) => d.toLowerCase());

  const chains = new Set<string>();
  const entities = new Set<string>();

  for (const m of mentions) {
    if (CHAIN_HANDLES[m]) chains.add(CHAIN_HANDLES[m]);
    if (ENTITY_HANDLES[m]) entities.add(ENTITY_HANDLES[m]);
  }
  for (const d of domains) {
    if (ENTITY_DOMAINS[d]) entities.add(ENTITY_DOMAINS[d]);
  }
  for (const [chain, tokens] of Object.entries(CHAIN_KEYWORDS)) {
    if (tokens.some((tok) => hasToken(text, tok))) chains.add(chain);
  }

  return {
    chains: [...chains].sort(),
    entities: [...entities].sort(),
  };
}

// Display helpers (fall back to a capitalized id for anything not in the map).
export function chainLabel(id: string): string {
  return CHAIN_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}
export function entityLabel(id: string): string {
  return ENTITY_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}
