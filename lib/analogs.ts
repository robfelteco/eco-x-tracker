// The analog-education curriculum — the tradfi concepts our ICP already thinks
// in, and what each one teaches about how money moves onchain.
//
// WHY THIS EXISTS
// Broad Educational is our largest pillar (71 posts) and every one of them is a
// market SIGNAL — Mastercard settling in six stablecoins, BNY and Circle, the
// a16z piece. None of them teaches a MECHANISM. We report the new world
// constantly and never explain the old one we are replacing. Jay's brief:
// "shine a light in the dark area of 'traditional money movement tech' ... if
// you can deeply understand the analog, you'll be much better equipped for the
// present/future." The four tiers below are his list, verbatim in structure.
//
// WHY IT IS A REGISTRY AND NOT A DISCOVER LENS
// lib/discover.ts scores by FRESHNESS — its three lenses all ask Grok for
// "developments from the last few weeks." A curriculum has no news. Correspondent
// banking was interesting in 1870 and it is interesting now. Curriculum scores by
// COVERAGE: a concept we have never taught stays worth teaching forever, and
// stops being worth teaching the moment we teach it well. Different scoring
// function, so it gets its own lane (see analogLanes() in lib/stats.ts).
//
// THE ONE NON-NEGOTIABLE FIELD: `breaksWhere`
// A registry that only stores the parallel produces "we're the Stripe of
// stablecoins" slop, and walks straight into the trap Ryne flagged — anchoring
// on payment orchestration "runs risk of confusion with Bridge etc," and
// "payments" is too crowded and limiting on its own. So every entry must say
// where the analogy FAILS. The parallel earns the reader's attention; the break
// is the post. The type makes it required, not optional.
//
// HARD RULE, enforced again in the drafter prompt: this registry is a DISCOVERY
// and TEACHING input. It is never a positioning output. We borrow the
// vocabulary and refuse the category — Eco stays the routing and execution
// layer no matter which analog a post teaches. Jay, to Ryne: "this is just for
// our personal algo for education. Not eco."
//
// Kept dependency-free (same rule as lib/products.ts and lib/icp.ts) so
// taxonomy, ingest, stats and the backfill scripts can all import it without a
// cycle.

export type AnalogTier = 1 | 2 | 3 | 4;
export type AnalogSide = "technical" | "commercial";

export interface AnalogSource {
  title: string;
  url: string;
}

export interface AnalogDef {
  id: string;
  label: string;
  /** Jay's own tiering. 1 = direct analogs, 4 = rails context. */
  tier: AnalogTier;
  /**
   * Which door this concept walks through. Analog education skews commercial —
   * the app's ICP registry (lib/icp.ts) skews technical, because it is derived
   * from docs.eco.com's integrator personas. The gap is the point: this is how
   * the board can say "you have run the technical door six times and never the
   * commercial one."
   */
  side: AnalogSide;
  /** ICP ids from lib/icp.ts. Who actually cares about this concept. */
  icps: string[];
  /**
   * 1-3, hand-set: how differentiated Eco's divergence is. Nostro is a 3 (the
   * break is sharp, true, and shipped); interchange is a 1 (the break is real
   * but thin). Feeds the coverage score so we teach the strong ones first.
   */
  breakStrength: 1 | 2 | 3;
  /**
   * The tradfi terms. Doubles as the detection vocabulary — unambiguous enough
   * to tag a post deterministically, same word-boundary approach as
   * lib/dimensions.ts. Keep ordinary English words out of here.
   */
  vocab: string[];
  /** How the analog maps. Handed to the drafter verbatim. */
  parallel: string;
  /** Where the mapping FAILS. Required. This is the post. */
  breaksWhere: string;
  /** What we may not claim while teaching this one. */
  guardrail?: string;
  /** Where we learned it, so a draft can cite the analog honestly. */
  sources?: AnalogSource[];
  /**
   * Institutional hubs the sweep enumerates for THIS concept (lib/analogSweep).
   * Editorial, so it lives in code next to the vocabulary rather than in a
   * table: which institution owns a mechanism is a judgment, not data.
   * mapReportHub() lists the real pieces below a hub, so point these at an
   * index page (a publications list, an insights blog), never at a homepage.
   */
  hubs?: string[];
}

export const TIER_LABEL: Record<AnalogTier, string> = {
  1: "Tier 1 — Direct analogs",
  2: "Tier 2 — Settlement & clearing",
  3: "Tier 3 — Routing sophistication",
  4: "Tier 4 — Rails context",
};

export const TIER_HINT: Record<AnalogTier, string> = {
  1: "Where the parallel is tightest — and where the miscategorisation risk is highest. Teach these to counter-position out of the category, never into it.",
  2: "The richest tier for us: three of these break in Eco's favour on shipped product. Speaks to treasury, issuers and institutional money movers.",
  3: "Highest technical credibility per post, smallest audience. Solvers, market makers and trading desks.",
  4: "Widest reach and the most familiar hooks — the entry tier for a reader new to the category.",
};

export const ANALOG_DEFS: AnalogDef[] = [
  // ---------------------------------------------------------------- Tier 1
  {
    id: "payment_orchestration",
    label: "Payment orchestration",
    tier: 1,
    side: "commercial",
    icps: ["payments", "exchanges"],
    breakStrength: 3,
    hubs: ["https://www.bis.org/cpmi/publications.htm"],
    vocab: [
      "payment orchestration",
      "payments orchestration",
      "orchestration platform",
      "acceptance rate",
      "authorisation rate",
      "authorization rate",
      "cascading payments",
      "provider-agnostic",
      "spreedly",
      "gr4vy",
    ],
    parallel:
      "One integration replaces N direct provider integrations, and RULE SETS — not just connectivity — are what separate real orchestration from a pile of plugins: block a problem customer at the API, tag an internal ID, track it through the whole journey. The honest sales posture is 'keep the integrations that are working and converting for you' — orchestration is for expansion into new geographies and local methods, not for ripping out what works.",
    breaksWhere:
      "Two breaks. (1) Orchestrators route between PROVIDERS of a single rail; Eco routes between MARKETS. (2) Orchestrators get paid by providers to steer flow — the PayModum operator concedes on camera that 'there's money exchanging hands as well and that obviously dilutes the true value proposition.' Neutrality is structural for Eco and commercial for them. Teaching this concept is how we counter-position OUT of the category.",
    guardrail:
      "Highest-risk entry in the registry. Per Ryne, anchoring here risks confusion with Bridge et al, and 'payments' is too crowded and limiting on its own. Never call Eco an orchestrator, a PSP or a gateway. Never imply fiat/stable orchestration.",
    sources: [
      {
        title: "PayModum — Payments Orchestration Explained",
        url: "https://www.youtube.com/watch?v=acPSHVJyF6g",
      },
    ],
  },
  {
    id: "smart_order_routing",
    label: "Smart Order Routing (SOR)",
    tier: 1,
    side: "technical",
    icps: ["treasury", "solvers"],
    breakStrength: 3,
    hubs: ["https://www.sec.gov/news/pressreleases"],
    vocab: [
      "smart order routing",
      "order routing",
      "child order",
      "order slicing",
      "book depth",
      "order book depth",
      "immediate-or-cancel",
      "price improvement",
      "market impact",
      "trading venue",
    ],
    parallel:
      "Near 1:1. Kill the naive model first — 'forget that old-timey idea of a single stock market; what we have now is a bit of a maze' — then name fragmentation and run the three-step loop: scan every venue, analyse price against depth and fees, execute, or split the parent order into child orders across several venues. The teaching core is the three-variable tradeoff: 'what good is a fantastic price if there are only 10 shares available and you're trying to buy a thousand?'",
    breaksWhere:
      "Equities have a consolidated tape and a legal best-execution duty. Onchain has neither, so best execution is unverifiable by construction — a product claim, not an audit. Note the gift: the NINX explainer closes by pointing at crypto itself (24/7, volatile, hundreds of venues) and says a system that sniffs out the best price 'isn't just helpful, it's absolutely essential.' A tradfi explainer making Eco's argument with no skin in the game.",
    sources: [
      { title: "NINX — Smart Order Routing Explained Simply", url: "https://www.youtube.com/watch?v=YwF41DJEr6I" },
      { title: "Quod Financial — What is Smart Order Routing", url: "https://www.quodfinancial.com/what-is-smart-order-routing-sor/" },
    ],
  },
  {
    id: "least_cost_routing",
    label: "Least-cost routing",
    tier: 1,
    side: "commercial",
    icps: ["payments", "treasury"],
    breakStrength: 2,
    hubs: ["https://www.federalreserve.gov/newsevents/speech"],
    vocab: ["least-cost routing", "least cost routing", "cost per transaction", "route selection", "rate card"],
    parallel:
      "Pick the cheapest viable path for each transaction against a known rate card, with a fallback if the first choice fails.",
    breaksWhere:
      "Onchain there is no rate card. Cost is gas + solver fee + depth-dependent slippage + probability of failure, recomputed every block — so least-cost is a live function, not a lookup. The compensating advantage: it can still be quoted definitively BEFORE you commit. That is the definite-quote outcome via Routes, and it has no tradfi equivalent at this granularity.",
    sources: [
      { title: "Quod Financial — What is Smart Order Routing", url: "https://www.quodfinancial.com/what-is-smart-order-routing-sor/" },
    ],
  },
  {
    id: "cascading_retries",
    label: "Smart transaction routing / retry cascades",
    tier: 1,
    side: "commercial",
    icps: ["payments", "wallets"],
    breakStrength: 2,
    hubs: ["https://www.ecb.europa.eu/press/pubbydate/html/index.en.html"],
    vocab: ["soft decline", "retry cascade", "smart transaction routing", "payment failover"],
    parallel:
      "A declined attempt is retried automatically down a ranked list of providers until one authorises. Recovered revenue is the whole ROI story.",
    breaksWhere:
      "Onchain a failed attempt is neither free nor private — it can burn gas and it leaks your intent to the mempool, so retrying is strictly worse than in cards. The answer is not a better cascade, it is all-or-nothing atomic execution: nothing partially fills, so there is nothing to unwind and nothing to retry.",
    sources: [
      { title: "PayModum — Payments Orchestration Explained", url: "https://www.youtube.com/watch?v=acPSHVJyF6g" },
    ],
  },
  {
    id: "gateway_vs_processor",
    label: "Gateway vs processor vs orchestrator",
    tier: 1,
    side: "commercial",
    icps: ["payments", "exchanges"],
    breakStrength: 2,
    hubs: ["https://www.bis.org/cpmi/publications.htm"],
    vocab: ["payment gateway", "payment processor", "merchant of record", "acquiring bank"],
    parallel:
      "The definitional post: money movement has always been layered, and knowing who does what is how a buyer evaluates anyone in the stack. Eco's own five-layer stack (issuers, rails, orchestrators, custodians, apps) is the same move applied onchain.",
    breaksWhere:
      "The onchain stack is not a relabelling of the card stack — there is no acquirer and no merchant of record, and the layer that consolidates last is the neutral aggregator. Use this concept to place Eco precisely: not a gateway, not an issuer, not a rail. The routing and execution layer.",
    guardrail: "Do not map Eco onto a card-stack role for narrative convenience. The point of the post is that the roles differ.",
    sources: [
      { title: "PayModum — Payments Orchestration Explained", url: "https://www.youtube.com/watch?v=acPSHVJyF6g" },
    ],
  },

  // ---------------------------------------------------------------- Tier 2
  {
    id: "correspondent_banking",
    label: "Correspondent banking",
    tier: 2,
    side: "commercial",
    icps: ["treasury", "issuers", "payments"],
    breakStrength: 2,
    hubs: ["https://www.bis.org/cpmi/publications.htm", "https://www.swift.com/news-events/news"],
    vocab: ["correspondent bank", "correspondent banking", "intermediary bank", "lifting fee", "de-risking"],
    parallel:
      "Cross-border value moves through a chain of intermediary banks, each taking a fee, adding a delay and applying its own cut-off times. Multi-hop routing with a toll booth at every hop.",
    breaksWhere:
      "The topology survives onchain — value still hops — but the trust model inverts. Each correspondent hop is a TRUST hop, exposing you to an institution you never chose. Each onchain hop is a VERIFICATION hop: decentralized prover contracts confirm the fill before the solver is paid. Same shape, opposite assumption.",
  },
  {
    id: "nostro_vostro",
    label: "Nostro / vostro accounts",
    tier: 2,
    side: "commercial",
    icps: ["treasury", "issuers", "solvers"],
    breakStrength: 3,
    hubs: ["https://www.swift.com/news-events/news"],
    vocab: ["nostro", "vostro", "pre-funding", "prefunding", "pre-funded", "trapped capital", "intraday credit"],
    parallel:
      "To settle locally everywhere, a bank pre-funds accounts at every counterparty. The cost is capital sitting dead in dozens of places, sized for peak demand, earning nothing. Pre-funding is the single largest hidden cost in cross-border money movement.",
    breaksWhere:
      "Stablecoins were supposed to kill pre-funding — then solver inventory models quietly rebuilt it, because a solver has to hold stock on every chain it wants to fill on. Flash Intents remove the requirement outright: the solver routes the swap using the USER's capital, atomically and trustlessly, repaying inside the same transaction, fronting no liquidity of its own. Onchain finally has no nostro. Sharpest break in the registry, and it is shipped, not roadmap.",
  },
  {
    id: "chips_fedwire_cls",
    label: "CHIPS / Fedwire / CLS",
    tier: 2,
    side: "commercial",
    icps: ["treasury", "issuers"],
    breakStrength: 3,
    hubs: [
      "https://www.cls-group.com/insights/",
      "https://www.federalreserve.gov/newsevents/speech",
    ],
    vocab: ["fedwire", "chips", "herstatt", "payment-versus-payment", "settlement window", "central bank money"],
    parallel:
      "CLS exists for one reason: in a two-sided FX settlement, one leg can pay and the other can fail — Herstatt risk, named after the bank that proved it in 1974. An entire piece of global infrastructure exists to make both legs move together.",
    breaksWhere:
      "Atomic onchain execution is payment-versus-payment by construction. The property CLS was purpose-built to provide is a default of the substrate. Strongest 'you built a system for a problem we don't have' hook available, and it lands with treasury and issuer readers who know exactly what Herstatt risk is.",
  },
  {
    id: "net_vs_gross",
    label: "Net vs gross settlement (RTGS vs DNS)",
    tier: 2,
    side: "commercial",
    icps: ["treasury", "payments"],
    breakStrength: 2,
    hubs: ["https://www.bankofengland.co.uk/news/publications"],
    vocab: ["rtgs", "real-time gross settlement", "deferred net settlement", "multilateral netting", "liquidity savings"],
    parallel:
      "Systems net obligations because gross settlement is expensive in liquidity — you would need the full amount on hand for every transaction rather than the net difference. Netting is a liquidity-savings mechanism, not a speed one.",
    breaksWhere:
      "Onchain is gross and atomic by default, which sounds strictly better and mostly is. The genuinely interesting question — and the better post — is where netting STILL wins onchain: intent batching, aggregated solver flow, anything where the gas cost of gross settlement exceeds the capital cost of holding the position. Refusing the easy triumphalism is what makes this credible.",
  },
  {
    id: "swift_messaging",
    label: "SWIFT (MT103, gpi)",
    tier: 2,
    side: "commercial",
    icps: ["payments", "issuers"],
    breakStrength: 3,
    hubs: ["https://www.swift.com/news-events/news"],
    vocab: ["swift", "mt103", "swift gpi", "payment instruction", "messaging layer"],
    parallel:
      "The most under-known fact in money movement: SWIFT moves MESSAGES, not money. The instruction and the settlement are two separate systems, and reconciling them is an entire job category employing thousands of people.",
    breaksWhere:
      "Onchain the message IS the settlement. Two layers collapse into one and reconciliation-as-a-job-category disappears. Cleanest 'the old world has an extra layer you forgot about' post in the list, and it requires no Eco product claim at all — pure top-of-funnel.",
  },

  // ---------------------------------------------------------------- Tier 3
  {
    id: "best_execution",
    label: "Best execution / Reg NMS",
    tier: 3,
    side: "technical",
    icps: ["treasury", "solvers"],
    breakStrength: 3,
    hubs: ["https://www.sec.gov/news/pressreleases"],
    vocab: [
      "best execution",
      "reg nms",
      "mifid",
      "consolidated tape",
      "transaction cost analysis",
      "best-ex",
    ],
    parallel:
      "A broker has a legal duty to get the client the best available terms, and a formal discipline for proving it afterwards: transaction cost analysis, measured against a public consolidated tape. Slippage is the visible cost — 'the price you thought you were getting when you clicked buy isn't the price you actually got.'",
    breaksWhere:
      "Onchain has the fragmentation but none of the obligation and — more importantly — no consolidated tape. No tape means no denominator, which means onchain TCA is effectively unmeasured across the industry. 'What is your onchain TCA?' is a question our ICP cannot currently answer, which makes it an excellent post and an honest one.",
    guardrail:
      "Trusted price benchmarks and a stablecoin reference rate are ROADMAP. Ask the question and name the gap; never state that Eco publishes a live benchmark.",
    sources: [
      { title: "Quod Financial — What is Smart Order Routing", url: "https://www.quodfinancial.com/what-is-smart-order-routing-sor/" },
    ],
  },
  {
    id: "fx_liquidity_aggregation",
    label: "FX liquidity aggregation",
    tier: 3,
    side: "technical",
    icps: ["treasury", "solvers", "issuers"],
    breakStrength: 2,
    hubs: ["https://www.bis.org/statistics/index.htm"],
    vocab: ["liquidity aggregation", "request for quote", "streaming price", "last look", "bid-offer spread"],
    parallel:
      "Aggregate many liquidity providers behind one price. Streaming quotes for small size, request-for-quote for large size, and LP tiering so your best counterparties see your best flow.",
    breaksWhere:
      "Tradfi FX keeps streaming and RFQ in separate venues with separate relationships. Onchain both live in the same venue set — AMM depth is streaming liquidity, solver competition is RFQ — and one router can weigh them against each other in a single decision. That combination has no clean tradfi counterpart.",
  },
  {
    id: "prime_brokerage",
    label: "Prime brokerage in FX",
    tier: 3,
    side: "commercial",
    icps: ["treasury", "issuers"],
    breakStrength: 2,
    hubs: ["https://www.newyorkfed.org/newsevents/news"],
    vocab: ["prime brokerage", "prime broker", "credit intermediation", "give-up"],
    parallel:
      "One credit relationship gives you access to many venues — the prime broker stands in the middle so you do not have to onboard, KYB and take credit exposure to every counterparty separately. This is exactly the 'one integration instead of KYB with twelve platforms' pitch, made forty years earlier.",
    breaksWhere:
      "A prime broker intermediates CREDIT and takes principal risk to do it. Eco intermediates EXECUTION and takes none. That is a genuine capability difference, not a hedge — and it is also a hard line: Eco must never be positioned as a market maker or principal-risk taker.",
    guardrail: "Do not let the prime-brokerage analogy imply Eco extends credit, warehouses risk, or acts as principal.",
  },
  {
    id: "dark_pool_routing",
    label: "Dark pool routing",
    tier: 3,
    side: "technical",
    icps: ["treasury", "solvers"],
    breakStrength: 3,
    hubs: ["https://www.sec.gov/news/pressreleases"],
    vocab: ["dark pool", "information leakage", "hidden liquidity", "systematic internaliser", "alternative trading system"],
    parallel:
      "Large orders hide from the public book because showing size moves the price against you. Whole venues exist purely to conceal intent until after the fill.",
    breaksWhere:
      "It INVERTS. Onchain there is no dark venue — the mempool is a public preview of your intention, so your order IS the signal. Tradfi spent decades building places to hide; onchain starts with nowhere to hide. That reframe is the clearest way to make intent-based execution legible to an institutional reader in a single post.",
    sources: [
      { title: "Quod Financial — What is Smart Order Routing", url: "https://www.quodfinancial.com/what-is-smart-order-routing-sor/" },
    ],
  },
  {
    id: "fix_protocol",
    label: "FIX protocol",
    tier: 3,
    side: "technical",
    icps: ["builders", "solvers", "agents"],
    breakStrength: 2,
    hubs: ["https://www.fixtrading.org/news/"],
    vocab: ["fix protocol", "fix engine", "order management system", "wire format"],
    parallel:
      "A shared wire format is what let venues interoperate at all. FIX is boring, and it is the reason a single order-management system can talk to every exchange on earth.",
    breaksWhere:
      "There is no FIX onchain. Every VM is its own dialect, and every new chain is a fresh integration for anyone who has not abstracted it. Routes V2's universal encoding is the same move FIX made — extend one interface past the EVM rather than shipping a new client per chain.",
  },

  // ---------------------------------------------------------------- Tier 4
  {
    id: "interchange",
    label: "Interchange / acquiring vs issuing",
    tier: 4,
    side: "commercial",
    icps: ["payments"],
    breakStrength: 1,
    hubs: ["https://www.ecb.europa.eu/press/pubbydate/html/index.en.html"],
    vocab: ["interchange", "interchange fee", "scheme fee", "merchant discount rate", "card acquiring"],
    parallel:
      "The clearest 'who pays and who captures' lesson in payments: the merchant pays, the issuing bank captures most of it, and the fee is set by a scheme neither party controls.",
    breaksWhere:
      "Onchain there is no interchange. The cost is execution — gas, solver competition, spread — not rent extracted by a scheme. Useful for reframing 'cheaper payments' away from a discount claim and toward a structural one. Weakest break in the registry; best as supporting material rather than a post subject.",
  },
  {
    id: "instant_rails",
    label: "ACH / SEPA Instant / FedNow / UPI / Pix",
    tier: 4,
    side: "commercial",
    icps: ["payments", "wallets"],
    breakStrength: 2,
    hubs: [
      "https://www.federalreserve.gov/newsevents/pressreleases.htm",
      "https://www.europeanpaymentscouncil.eu/news-insights",
    ],
    vocab: ["fednow", "sepa instant", "automated clearing house", "unified payments interface", "instant payment rail"],
    parallel:
      "Instant domestic rails already exist and they work extremely well. Pix and UPI are the proof that a well-designed public rail can move a whole country in a few years.",
    breaksWhere:
      "They are domestic and closed. The gap stablecoins actually fill is cross-border and programmable — NOT 'faster than ACH,' which is a weak claim a Pix user will laugh at. This entry exists partly to stop that claim being made, and to redirect toward reachability and programmability.",
    guardrail: "Never claim stablecoins are faster than a modern domestic instant rail. Compete on reach and programmability.",
  },
  {
    id: "iso_20022",
    label: "ISO 20022",
    tier: 4,
    side: "commercial",
    icps: ["payments", "treasury", "agents"],
    breakStrength: 2,
    hubs: ["https://www.swift.com/news-events/news", "https://www.bis.org/cpmi/publications.htm"],
    vocab: ["iso 20022", "structured remittance", "remittance data", "message schema"],
    parallel:
      "Global money movement is converging on structured, data-rich messages — the whole industry is mid-migration, and the payoff is that a payment can finally carry meaningful context.",
    breaksWhere:
      "ISO 20022 makes payment data DESCRIPTIVE. Onchain it can be EXECUTABLE: a Programmable Address does not describe what should happen to an inbound transfer, it performs it — swap, bridge, deposit or split, by rules set in advance. Strong bridge from a concept institutions are actively budgeting for to a product that exists.",
  },
  {
    id: "ccp_clearing",
    label: "DTCC / NSCC clearing",
    tier: 4,
    side: "commercial",
    icps: ["issuers", "treasury"],
    breakStrength: 2,
    hubs: ["https://www.dtcc.com/dtcc-connection"],
    vocab: ["central counterparty", "novation", "clearing house", "guarantee fund", "clearing member", "dtcc", "nscc"],
    parallel:
      "A central counterparty steps into the middle of every trade — novation — so neither side carries the other's settlement risk. Margin and a guarantee fund pay for that comfort.",
    breaksWhere:
      "Atomic settlement removes the reason a CCP exists in the first place: no novation, no margin, no guarantee fund, because there is no window in which one side is exposed. The caveat makes the post better rather than worse — CCPs also net, mutualise default and support securities lending, so this argues against one function, not the institution.",
    guardrail: "Do not claim onchain settlement replaces everything a CCP does. Argue the narrow, correct point.",
  },
  {
    id: "settlement_cycle",
    label: "T+2 settlement",
    tier: 4,
    side: "commercial",
    icps: ["issuers", "treasury"],
    breakStrength: 3,
    hubs: ["https://www.dtcc.com/dtcc-connection", "https://www.sec.gov/news/pressreleases"],
    vocab: ["t+2", "t+1", "settlement cycle", "settlement fails", "buy-in", "trade affirmation"],
    parallel:
      "The most famous 'why does this take days?' hook in finance, and the one every reader already half-knows. Netting cycles, funding windows, fails and buy-ins.",
    breaksWhere:
      "The lazy version is 'we do T+0, they do T+2.' The honest version is better and it is a thought-leadership post: the industry moved to T+1 and it was operationally brutal, because the delay was never mainly technical — it was funding, affirmation and staffing. Which means tokenization's real fight is operational, not cryptographic. Refusing the easy win is what makes it credible with an institutional reader.",
  },
];

export const ANALOG_BY_ID: Record<string, AnalogDef> = Object.fromEntries(
  ANALOG_DEFS.map((a) => [a.id, a]),
);

export const ANALOG_IDS = ANALOG_DEFS.map((a) => a.id);

export function analogLabel(id: string | null | undefined): string {
  if (!id) return "Unassigned";
  return ANALOG_BY_ID[id]?.label ?? id.replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// The teaching SHAPES.
//
// The reason Jay pointed at those specific explainers is not the vocabulary
// list — it is the narrative moves. Every one of them uses the same handful of
// structures, and all of them transfer. These are handed to the drafter so a
// curriculum post has a shape to take, rather than defaulting to "here is a
// fact about correspondent banking."
// ---------------------------------------------------------------------------
export interface EducationShape {
  id: string;
  label: string;
  brief: string;
}

export const EDUCATION_SHAPES: EducationShape[] = [
  {
    id: "kill_the_model",
    label: "Kill the naive model",
    brief:
      "Open by demolishing an assumption the reader holds, then let the post be the repair. 'Forget that old-timey idea of a single stock market.' Eco form: 'There is no such thing as the price of USDC.' Our strongest unused cold open — the corpus opens with facts, never with corrections.",
  },
  {
    id: "condition_then_discipline",
    label: "Condition, then the discipline it forces",
    brief:
      "Two beats that make an argument feel inevitable instead of promotional: name the market condition, then the practice it forced into existence. Fragmentation forced best execution, which forced smart order routing.",
  },
  {
    id: "three_variable_tradeoff",
    label: "The three-variable tradeoff",
    brief:
      "Show that optimising one variable wrecks another. Price, depth and fees in equities; quoted rate, available depth at that rate, and total cost including gas, solver fee and failure probability onchain. The most ownable teaching vein we have.",
  },
  {
    id: "hidden_cost",
    label: "Price the cost they can't see",
    brief:
      "Name a cost the reader is already paying and has never measured, and give it the industry's own word for it. Slippage. Pre-funding drag. Reconciliation headcount. Ends naturally on a question the reader cannot answer, which is what earns replies.",
  },
  {
    id: "integrate_vs_operate",
    label: "Integration is a week, operating it is forever",
    brief:
      "'Integrating, sure it's a week's work — but the reality is you're always going to have changes. It is very expensive to maintain APIs.' The most persuasive form of an argument already in our boilerplate: without needing to deploy custom onchain infrastructure.",
  },
  {
    id: "closed_loop",
    label: "The closed loop",
    brief:
      "Route, measure, re-route. Do one narrow specific thing, then show the analytics that feed back into the next decision — what makes a capability read as a system. Lifted from the Stripe orchestration demo's closing beat.",
  },
];

export const SHAPE_BY_ID: Record<string, EducationShape> = Object.fromEntries(
  EDUCATION_SHAPES.map((s) => [s.id, s]),
);

// ---------------------------------------------------------------------------
// Detection.
//
// Word-boundary matching over `vocab`, mirroring hasToken() in lib/dimensions.ts
// so "chips" inside "microchips" never tags CHIPS/Fedwire. Deliberately strict:
// a post is tagged with at most ONE concept (the longest match wins, since a
// longer phrase is a more specific signal), because a teaching post is about one
// mechanism. A post that merely name-drops a term in passing should not be
// counted as having taught it — the coverage board would lie.
// ---------------------------------------------------------------------------
function hasToken(haystack: string, token: string): boolean {
  const t = token.toLowerCase();
  const i = haystack.indexOf(t);
  if (i === -1) return false;
  const before = haystack[i - 1];
  const after = haystack[i + t.length];
  const wordish = (c: string | undefined) => !!c && /[a-z0-9]/.test(c);
  return !wordish(before) && !wordish(after);
}

export function detectAnalog(text: string): string | null {
  const hay = (text || "").toLowerCase();
  if (!hay) return null;
  let best: { id: string; len: number } | null = null;
  for (const a of ANALOG_DEFS) {
    for (const tok of a.vocab) {
      if (hasToken(hay, tok) && (!best || tok.length > best.len)) {
        best = { id: a.id, len: tok.length };
      }
    }
  }
  return best?.id ?? null;
}

// Compact block for a Claude prompt that needs the whole curriculum in view
// (the question-mining lane uses this to pick which concept a question belongs
// to). Parallel and break are deliberately omitted here — this is for routing,
// not for drafting.
export function analogPromptIndex(): string {
  return ANALOG_DEFS.map((a) => `- ${a.id} (tier ${a.tier}, ${a.side}): ${a.label}`).join("\n");
}
