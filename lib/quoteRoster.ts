import { sql } from "./db.ts";

// The roster — the credibility filter for quote discovery.
//
// Per the spec (§4, §12 step 1): "hand-seed 40-60 people across the three org
// tiers before writing any fetch code. The pipeline is only as good as this
// table." Everything downstream — scoring, the read budget, who is even
// eligible to produce a candidate — keys off these two tables.
//
// The seed below is drawn from people @eco has ALREADY quote-carded (verifiable
// against our own corpus) plus the obvious public voices in the space. Titles
// drift, so nothing here is treated as verified: `handles_verified_at` stays
// null until an operator confirms it in the UI, and the review card shows an
// unverified badge. Verify before a card ships.

export interface OrgSeed {
  name: string;
  tier: 1 | 2 | 3; // 1 = TradFi/global brand, 2 = major stablecoin/fintech, 3 = crypto infra
  xHandle?: string;
  isCompetitor?: boolean;
}

export interface PersonSeed {
  name: string;
  title: string;
  org: string;
  seniority: 1 | 2 | 3; // 1 = C-suite/founder, 2 = SVP/MD/Head of, 3 = Director/PM
  xHandle?: string;
}

export const ORG_SEED: OrgSeed[] = [
  // Tier 1 — TradFi and global brands. A quote from here carries the most weight.
  { name: "Visa", tier: 1, xHandle: "Visa" },
  { name: "Mastercard", tier: 1, xHandle: "Mastercard" },
  { name: "Citi", tier: 1, xHandle: "Citi" },
  { name: "JPMorgan", tier: 1, xHandle: "jpmorgan" },
  { name: "BlackRock", tier: 1, xHandle: "BlackRock" },
  { name: "Franklin Templeton", tier: 1, xHandle: "FTI_US" },
  { name: "BNY", tier: 1, xHandle: "BNYglobal" },
  { name: "Standard Chartered", tier: 1, xHandle: "StanChart" },
  { name: "Fiserv", tier: 1, xHandle: "Fiserv" },
  { name: "Western Union", tier: 1, xHandle: "WesternUnion" },
  { name: "MoneyGram", tier: 1, xHandle: "MoneyGram" },
  { name: "PayPal", tier: 1, xHandle: "PayPal" },
  { name: "Stripe", tier: 1, xHandle: "stripe" },
  { name: "DoorDash", tier: 1, xHandle: "DoorDash" },
  { name: "Nubank", tier: 1, xHandle: "nubank" },
  { name: "Revolut", tier: 1, xHandle: "RevolutApp" },
  { name: "SoFi", tier: 1, xHandle: "SoFi" },
  { name: "Moody's Ratings", tier: 1, xHandle: "moodysratings" },
  { name: "Federal Reserve", tier: 1 },
  { name: "BIS", tier: 1 },
  // Professional-services research desks. Added after a live run surfaced a
  // genuine KPMG quote inside a Chainalysis report that scored as "unrostered"
  // purely because we weren't tracking the firm.
  { name: "KPMG", tier: 1, xHandle: "KPMG" },
  { name: "Deloitte", tier: 1, xHandle: "Deloitte" },
  { name: "EY", tier: 1, xHandle: "EYnews" },
  { name: "PwC", tier: 1, xHandle: "PwC" },
  { name: "McKinsey & Company", tier: 1, xHandle: "McKinsey" },

  // Tier 2 — major stablecoin issuers, infra and fintech.
  { name: "Circle", tier: 2, xHandle: "circle" },
  { name: "Tether", tier: 2, xHandle: "Tether_to" },
  { name: "Paxos", tier: 2, xHandle: "Paxos" },
  { name: "Coinbase", tier: 2, xHandle: "coinbase" },
  { name: "Robinhood", tier: 2, xHandle: "RobinhoodApp" },
  { name: "Kraken", tier: 2, xHandle: "krakenfx" },
  { name: "BVNK", tier: 2, xHandle: "BVNKfinance" },
  { name: "Bridge", tier: 2, xHandle: "stablecoin" },
  { name: "Zero Hash", tier: 2, xHandle: "zerohash" },
  { name: "Fireblocks", tier: 2, xHandle: "FireblocksHQ" },
  { name: "Anchorage Digital", tier: 2, xHandle: "Anchorage" },
  { name: "MoonPay", tier: 2, xHandle: "moonpay" },
  { name: "Crossmint", tier: 2, xHandle: "crossmint" },
  { name: "Deel", tier: 2, xHandle: "Deel" },
  { name: "Galaxy", tier: 2, xHandle: "galaxyhq" },
  { name: "Worldpay", tier: 2, xHandle: "Worldpay" },

  // Tier 3 — crypto infra, chains and funds.
  { name: "Polygon", tier: 3, xHandle: "0xPolygon" },
  { name: "Solana Foundation", tier: 3, xHandle: "solana" },
  { name: "Tempo", tier: 3, xHandle: "tempo" },
  { name: "Hyperliquid", tier: 3, xHandle: "HyperliquidX" },
  { name: "Dragonfly", tier: 3, xHandle: "Dragonfly_xyz" },
  { name: "a16z crypto", tier: 3, xHandle: "a16zcrypto" },
  { name: "Chainalysis", tier: 3, xHandle: "chainalysis" },
  { name: "Artemis", tier: 3, xHandle: "artemis__xyz" },
  { name: "LI.FI", tier: 3, xHandle: "lifiprotocol" },
  { name: "Para", tier: 3, xHandle: "getpara" },
  { name: "Activant Capital", tier: 3, xHandle: "ActivantCapital" },
];

// Seeded from people @eco has already quote-carded (so the titles came off our
// own published cards) plus obvious public voices. Unverified until an operator
// confirms — see the note at the top of this file.
export const PEOPLE_SEED: PersonSeed[] = [
  // Already carded by @eco — highest-confidence seeds.
  { name: "Rubail Birwadker", title: "Global Head of Growth", org: "Visa", seniority: 2, xHandle: "rubail" },
  { name: "Jack Forestell", title: "Chief Product & Strategy Officer", org: "Visa", seniority: 1, xHandle: "jackforestell" },
  { name: "Cuy Sheffield", title: "Head of Crypto", org: "Visa", seniority: 2, xHandle: "cuysheffield" },
  { name: "Biswarup Chatterjee", title: "Global Head of Partnerships & Innovation, Citi Services", org: "Citi", seniority: 2 },
  { name: "Takis Georgakopoulos", title: "Chief Operating Officer", org: "Fiserv", seniority: 1 },
  { name: "Brian Armstrong", title: "Chief Executive Officer", org: "Coinbase", seniority: 1, xHandle: "brian_armstrong" },
  { name: "Andy Fang", title: "Co-Founder", org: "DoorDash", seniority: 1, xHandle: "andyfang" },
  { name: "Anthony Soohoo", title: "Chief Executive Officer", org: "MoneyGram", seniority: 1, xHandle: "anthonysoohoo" },
  { name: "Matthew Cagwin", title: "Chief Financial Officer", org: "Western Union", seniority: 1 },
  { name: "Caroline D. Pham", title: "Chief Legal Officer", org: "MoonPay", seniority: 1, xHandle: "CarolineDPham" },
  { name: "Cristiano Ventricelli", title: "VP, Senior Analyst, Digital Assets", org: "Moody's Ratings", seniority: 3 },
  { name: "Chris Harmse", title: "Co-Founder & Chief Business Officer", org: "BVNK", seniority: 1, xHandle: "chrisharmse89" },
  { name: "Rob Hadick", title: "General Partner", org: "Dragonfly", seniority: 1, xHandle: "HadickM" },
  { name: "John Egan", title: "Chief Product Officer", org: "Polygon", seniority: 1, xHandle: "john3gan" },
  { name: "Rodri Fernandez Touza", title: "Co-Founder", org: "Crossmint", seniority: 1, xHandle: "rodrifernandezt" },
  { name: "Thierry Edde", title: "Head of Crypto", org: "Deel", seniority: 2, xHandle: "thierryEdde44" },
  { name: "Stephen Miran", title: "Member, Board of Governors", org: "Federal Reserve", seniority: 1, xHandle: "SteveMiran" },

  // Obvious public voices in the stablecoin market not yet carded.
  { name: "Jeremy Allaire", title: "Co-Founder & Chief Executive Officer", org: "Circle", seniority: 1, xHandle: "jerallaire" },
  { name: "Dante Disparte", title: "Chief Strategy Officer & Head of Global Policy", org: "Circle", seniority: 1, xHandle: "ddisparte" },
  { name: "Paolo Ardoino", title: "Chief Executive Officer", org: "Tether", seniority: 1, xHandle: "paoloardoino" },
  { name: "Charles Cascarilla", title: "Co-Founder & Chief Executive Officer", org: "Paxos", seniority: 1, xHandle: "CCascarilla" },
  { name: "Patrick Collison", title: "Co-Founder & Chief Executive Officer", org: "Stripe", seniority: 1, xHandle: "patrickc" },
  { name: "John Collison", title: "Co-Founder & President", org: "Stripe", seniority: 1, xHandle: "collision" },
  { name: "Jesse Pollak", title: "Creator of Base", org: "Coinbase", seniority: 2, xHandle: "jessepollak" },
  { name: "Nikolai Mushegian", title: "Head of Payments Product", org: "Bridge", seniority: 2 },
  { name: "Michael Shaulov", title: "Co-Founder & Chief Executive Officer", org: "Fireblocks", seniority: 1, xHandle: "MichaelShaulov" },
  { name: "Nathan McCauley", title: "Co-Founder & Chief Executive Officer", org: "Anchorage Digital", seniority: 1, xHandle: "nathanmccauley" },
  { name: "Ivan Soto-Wright", title: "Co-Founder & Chief Executive Officer", org: "MoonPay", seniority: 1, xHandle: "ivansotowright" },
  { name: "Edward Woodford", title: "Co-Founder & Chief Executive Officer", org: "Zero Hash", seniority: 1, xHandle: "edwoodford" },
  { name: "Chris Dixon", title: "Founder & Managing Partner", org: "a16z crypto", seniority: 1, xHandle: "cdixon" },
  { name: "Michael Jordan", title: "Chief Executive Officer", org: "Artemis", seniority: 1 },
  { name: "Philipp Zentner", title: "Co-Founder & Chief Executive Officer", org: "LI.FI", seniority: 1, xHandle: "philippzentner" },
  { name: "David Vorick", title: "Co-Founder", org: "Para", seniority: 1 },
  { name: "Vlad Tenev", title: "Co-Founder & Chief Executive Officer", org: "Robinhood", seniority: 1, xHandle: "vladtenev" },
  { name: "Nikolay Storonsky", title: "Co-Founder & Chief Executive Officer", org: "Revolut", seniority: 1 },
  { name: "David Vélez", title: "Founder & Chief Executive Officer", org: "Nubank", seniority: 1 },
  { name: "Anthony Noto", title: "Chief Executive Officer", org: "SoFi", seniority: 1, xHandle: "anthonynoto" },
  { name: "Raj Dhamodharan", title: "EVP, Blockchain & Digital Assets", org: "Mastercard", seniority: 2, xHandle: "rajdhamo" },
  { name: "Ryan Rugg", title: "Global Head of Digital Assets, TTS", org: "Citi", seniority: 2 },
  { name: "Sandy Kaul", title: "SVP, Digital Asset & Industry Advisory Services", org: "Franklin Templeton", seniority: 2 },
  { name: "Robert Mitchnick", title: "Head of Digital Assets", org: "BlackRock", seniority: 2 },
  { name: "Caroline Butler", title: "Global Head of Digital Assets", org: "BNY", seniority: 2 },
  { name: "Nick Philpott", title: "Co-Founder", org: "Standard Chartered", seniority: 2 },
  { name: "Mike Novogratz", title: "Founder & Chief Executive Officer", org: "Galaxy", seniority: 1, xHandle: "novogratz" },
];

// The podcast / conference circuit and report publishers we sweep. These aren't
// tied to one person, so they live in watch_sources rather than people.
export const WATCH_SEED: { kind: string; identifier: string; label: string }[] = [
  { kind: "yt_channel", identifier: "@Bankless", label: "Bankless" },
  { kind: "yt_channel", identifier: "@UnchainedCrypto", label: "Unchained" },
  { kind: "yt_channel", identifier: "@a16zcrypto", label: "a16z crypto" },
  { kind: "yt_channel", identifier: "@CoinDesk", label: "CoinDesk (Consensus)" },
  { kind: "yt_channel", identifier: "@Token2049", label: "Token2049" },
  // Stored as a channelId, not a handle: @Money2020 does not resolve, and the
  // handle search returns three plausible-looking channels. Pinning the id
  // removes the ambiguity — resolveYouTubeChannel() passes UC… ids straight
  // through.
  { kind: "yt_channel", identifier: "UCip4CIpmM13NOAH-j9GiAzg", label: "Money20/20.tv" },
  // The three channels the curriculum lane watches (lib/channels.ts). Seeded
  // here too so the QUOTE lane lists them as well: one transcript in
  // raw_documents serves both consumers, and whichever lane reaches a video
  // first pays for it. Pinned as channelIds for the same reason Money20/20 is —
  // a handle can be changed by its owner.
  { kind: "yt_channel", identifier: "UC03s4ohGxrFSMHxGR8DMzZg", label: "Money Code" },
  { kind: "yt_channel", identifier: "UC8SaXHFAqVHUjE2OLUFakjw", label: "Tokenized" },
  { kind: "yt_channel", identifier: "UCoX2V7454TPPAhWu172lGGQ", label: "What's Next with Philip Meissner" },
  { kind: "report_site", identifier: "usa.visa.com/solutions/crypto", label: "Visa Onchain Analytics" },
  { kind: "report_site", identifier: "citigroup.com/global/insights", label: "Citi GPS" },
  { kind: "report_site", identifier: "bis.org/publ", label: "BIS publications" },
  { kind: "report_site", identifier: "a16zcrypto.com/posts", label: "a16z crypto research" },
  { kind: "report_site", identifier: "chainalysis.com/blog", label: "Chainalysis research" },
  { kind: "report_site", identifier: "artemis.xyz/research", label: "Artemis research" },
  // Roster-discovery sweeps: results become "Add to roster?" suggestions, never
  // quote candidates. See lib/quoteLaneX.ts.
  { kind: "x_search", identifier: "stablecoin (settlement OR clearing OR treasury OR institutional) -is:retweet lang:en", label: "Stablecoin × institutional" },
  { kind: "x_search", identifier: "stablecoin (payments OR payout OR remittance) -is:retweet lang:en", label: "Stablecoin × payments" },
];

// --- Reads -----------------------------------------------------------------

export interface RosterPerson {
  id: number;
  fullName: string;
  title: string;
  seniority: number;
  xHandle: string | null;
  xAuthorId: string | null;
  xSinceId: string | null;
  ytChannel: string | null;
  orgId: number | null;
  orgName: string | null;
  orgTier: number | null;
  isCompetitor: boolean;
  handlesVerifiedAt: string | null;
}

export async function getRoster(onlyWithX = false): Promise<RosterPerson[]> {
  return sql<RosterPerson>`
    SELECT p.id, p.full_name AS "fullName", p.title, p.seniority,
           p.x_handle AS "xHandle", p.x_author_id AS "xAuthorId", p.x_since_id AS "xSinceId",
           p.yt_channel AS "ytChannel",
           p.org_id AS "orgId", o.name AS "orgName", o.org_tier AS "orgTier",
           COALESCE(o.is_competitor, false) AS "isCompetitor",
           p.handles_verified_at AS "handlesVerifiedAt"
    FROM people p
    LEFT JOIN orgs o ON o.id = p.org_id
    WHERE p.active = true
      AND (${!onlyWithX} OR p.x_handle IS NOT NULL)
    ORDER BY o.org_tier NULLS LAST, p.seniority, p.full_name
  `;
}

export async function getWatchSources(kind?: string) {
  return sql<{ id: number; kind: string; identifier: string; label: string; lastRunAt: string | null }>`
    SELECT id, kind, identifier, label, last_run_at AS "lastRunAt"
    FROM watch_sources
    WHERE active = true AND (${kind ?? null}::text IS NULL OR kind = ${kind ?? null})
    ORDER BY kind, label
  `;
}

export async function rosterCounts(): Promise<{ people: number; orgs: number; withX: number; suggestions: number }> {
  const rows = await sql<{ people: number; orgs: number; withX: number; suggestions: number }>`
    SELECT
      (SELECT COUNT(*)::int FROM people WHERE active) AS people,
      (SELECT COUNT(*)::int FROM orgs) AS orgs,
      (SELECT COUNT(*)::int FROM people WHERE active AND x_handle IS NOT NULL) AS "withX",
      (SELECT COUNT(*)::int FROM roster_suggestions WHERE status = 'new') AS suggestions
  `;
  return rows[0];
}
