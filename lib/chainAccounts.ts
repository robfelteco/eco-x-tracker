// The X account each chain's momentum is read from.
//
// Handles only — no ids. A user lookup costs one read and the id never changes,
// so it is resolved once and cached in chain_momentum_sources.user_id
// (Migration 018).
//
// Every entry here must be an id in CHAIN_LABELS (lib/dimensions.ts), or the
// momentum row cannot join to anything the tracker already knows.

export interface ChainAccount {
  chain: string;
  handle: string;
  /**
   * Scanned by default. False for chains whose official account posts rarely
   * enough that a daily read is mostly wasted — they can be switched on in
   * chain_momentum_sources without a deploy.
   */
  enabled: boolean;
}

export const CHAIN_ACCOUNTS: ChainAccount[] = [
  // Eco is live on these. The reason the feature exists: "you haven't posted
  // chain integration in 30 days, and Base just came out with something and
  // they're ripping."
  { chain: "base", handle: "base", enabled: true },
  { chain: "solana", handle: "solana", enabled: true },
  { chain: "tron", handle: "trondao", enabled: true },
  { chain: "polygon", handle: "0xpolygon", enabled: true },
  { chain: "bnb", handle: "bnbchain", enabled: true },
  { chain: "hyperliquid", handle: "hyperliquidx", enabled: true },
  { chain: "robinhood", handle: "robinhoodcrypto", enabled: true },
  { chain: "arbitrum", handle: "arbitrum", enabled: true },
  { chain: "optimism", handle: "optimism", enabled: true },
  { chain: "unichain", handle: "unichain", enabled: true },
  { chain: "ethereum", handle: "ethereum", enabled: true },

  // Not integrated (or not yet). Worth watching — a chain making a splash is
  // exactly when the integration conversation is easiest — but off by default
  // so the daily bill stays small.
  { chain: "tempo", handle: "tempo_xyz", enabled: false },
  { chain: "plasma", handle: "plasma", enabled: false },
  { chain: "monad", handle: "monad", enabled: false },
  { chain: "sei", handle: "seinetwork", enabled: false },
  { chain: "sui", handle: "suinetwork", enabled: false },
  { chain: "aptos", handle: "aptos", enabled: false },
  { chain: "avalanche", handle: "avax", enabled: false },
  { chain: "celo", handle: "celo", enabled: false },
  { chain: "stellar", handle: "stellarorg", enabled: false },
  { chain: "xrpl", handle: "ripplexdev", enabled: false },
  { chain: "near", handle: "nearprotocol", enabled: false },
  { chain: "berachain", handle: "berachain", enabled: false },
  { chain: "zksync", handle: "zksync", enabled: false },
  { chain: "starknet", handle: "starknet", enabled: false },
  { chain: "ton", handle: "ton_blockchain", enabled: false },
];

export const CHAIN_ACCOUNT_BY_CHAIN = new Map(CHAIN_ACCOUNTS.map((c) => [c.chain, c]));
