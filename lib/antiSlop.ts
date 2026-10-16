// The anti-slop engine. ANTI-SLOP.md is the prose version of this file; the two
// are meant to be edited together.
//
// Three jobs, in the order they run:
//
//   1. sanitizePrompt()  strips slop from the prompt BEFORE it is sent. Prompt
//      style is imitated, and the assembled context pulls strings from a dozen
//      data files plus raw article bodies and video transcripts. Auditing those
//      by hand does not scale and does not cover DB content at all.
//   2. ANTI_SLOP_BRIEF + formBlock()  the rules the model is asked to follow.
//   3. autoFixSlop() then scanSlop()  what the model actually returned. Rules in
//      a prompt are followed most of the time. "Most of the time" is how an em
//      dash reaches a published post, so the mechanical bans are enforced in
//      code and the judgment calls are surfaced to the operator.
//
// Compiled 2026-08-28 from github.com/petergyang/no-ai-slop, sloptells.com, and
// louisabraham.github.io/load-bearing. Tier 6 added 2026-10-16 from the
// stop-slop skill (~/.claude/skills/stop-slop), after Rob read a week of
// pipeline drafts that cleared every check here and still read as machine
// prose: the tells had moved from WORDS to STRUCTURE. See ANTI-SLOP.md for
// provenance, the recorded disagreements between the sources, and the
// reasoning per rule.

export type SlopSeverity = "hard" | "soft";

export interface SlopFinding {
  /** Stable id, e.g. "thread", "em-dash", "register-budget". */
  rule: string;
  severity: SlopSeverity;
  /** What was matched, trimmed for display. */
  match: string;
  /** One line the operator (or the repair pass) can act on. */
  fix: string;
}

// ---------------------------------------------------------------------------
// Tier 1, words. Hard bans: no context makes these fine.
// ---------------------------------------------------------------------------

const BANNED_WORDS = [
  "delve", "foster", "leverage", "utilize", "utilise", "facilitate", "empower",
  "streamline", "robust", "cutting-edge", "paradigm shift", "game changer",
  "game-changer", "tapestry", "realm", "beacon", "multifaceted", "meticulous",
  "intricate", "paramount", "transformative", "elevate", "embark", "supercharge",
  "harness", "ever-evolving", "seamless", "seamlessly", "unlock", "unlocks",
  // Measured at 51x human baseline on sloptells AND near the top of the 2026
  // load-bearing cluster. Two independent methods agreeing is the whole reason
  // this one is a hard ban and the rest of its cluster is only a budget.
  "genuinely",
];

const BANNED_PHRASES = [
  "it's worth noting", "it is worth noting", "worth noting", "worth mentioning",
  "it's important to note", "it is important to note", "at the end of the day",
  "when it comes to", "at its core", "in today's world", "in the age of",
  "in the world of", "the reality is", "the truth is", "in terms of",
  "going forward", "let's dive in", "dive into", "that said", "here's the thing",
  "here's the kicker", "no fluff", "thrilled to announce", "excited to announce",
  "humbled to announce", "proud to announce", "we are excited",
  "this is huge", "this changes everything",
  // stop-slop additions (2026-10-16): throat-clearing, emphasis crutches and
  // meta-commentary the first three sources did not list.
  "it turns out", "make no mistake", "full stop.", "this matters because",
  "can we talk about", "i'm going to be honest", "i'll say it again",
  "spoiler:", "hint:", "feature, not a bug", "dressed up as",
  "you already know this", "but that's another post", "i promise",
  "in a world where", "take a step back", "moving forward", "circle back",
  "double down", "deep dive", "lean into", "on the same page",
];

// Business jargon with a plain replacement (stop-slop). SOFT, because two of
// these are Eco's own words: the one-liner says "navigating onchain markets"
// and the product posts say "landscape" about chains. Flagged, not vetoed.
const JARGON: { word: string; plain: string }[] = [
  { word: "navigate", plain: "handle, route, move through" },
  { word: "navigating", plain: "handling, routing, moving through" },
  { word: "unpack", plain: "explain" },
  { word: "landscape", plain: "market, field, set of chains" },
];

// Engagement bait. A report costs -234 and a mute -58.8; nothing on the positive
// side of the ledger covers either, so these are hard.
const BAIT_PHRASES = [
  "curious what others think", "curious to hear", "thoughts?", "who else",
  "am i the only one", "let me know below", "drop a comment", "like if you",
  "retweet if", "follow for more", "agree?",
];

// ---------------------------------------------------------------------------
// Tier 2, the 2026 agent register (Abraham's cluster).
//
// A budget, not a ban. Every word here is a legitimate English word and several
// are good ones. Three of them in one post is the cluster, not a voice. The
// subset kept is the part plausible in market copy: the cluster's long tail is
// code-review vocabulary ("mutation-checked", "byte-identical") that will never
// appear in an X post about stablecoin routing.
// ---------------------------------------------------------------------------

export const REGISTER_WORDS = [
  "load-bearing", "load bearing", "plainly", "quietly", "deliberately", "merely",
  "precisely", "structurally", "empirically", "materially", "outright", "nobody",
  "honestly", "asymmetry", "premise", "chokepoint", "backstop", "tripwire",
  "machinery", "substrate", "ratchet", "vacuous", "indistinguishable", "verbatim",
  "orthogonal", "latent", "rests on", "carve-out", "refuses", "asserts",
];

const REGISTER_BUDGET = 1;

// ---------------------------------------------------------------------------
// Tier 3, construction patterns. Regex where a regex is honest about what it
// catches; everything fuzzier is left to the model and the operator.
// ---------------------------------------------------------------------------

interface PatternRule {
  rule: string;
  severity: SlopSeverity;
  re: RegExp;
  fix: string;
}

const PATTERNS: PatternRule[] = [
  {
    rule: "binary-contrast",
    severity: "hard",
    re: /\b(?:it'?s|this is|that'?s|they'?re|we'?re)\s+not\s+(?:just\s+)?[^.?!,;]{2,60}[,.]\s*(?:it'?s|this is|that'?s|they'?re|we'?re)\b/gi,
    fix: "State the second half directly. Drop the negated setup.",
  },
  {
    rule: "binary-contrast",
    severity: "hard",
    re: /\bthe\s+(?:\w+\s+)?(?:question|point|issue|problem|answer)\s+(?:isn'?t|is not)\b/gi,
    fix: "State the claim without the negated frame.",
  },
  {
    rule: "real-question",
    severity: "hard",
    // sloptells: 29x human baseline, the highest-multiplier construct measured.
    // Widened 2026-10-16: the pipeline drafts had moved the same move onto
    // other nouns ("The actual shift is pre-funding", "the underlying problem
    // it solves is more specific", "the material question is whether").
    re: /\bthe\s+(?:real|actual|underlying|material|deeper|bigger|interesting)\s+(?:question|problem|issue|story|answer|reason|shift|change|point|risk|cost|constraint|number|detail|lesson|signal|work)\b|\bwhat\s+(?:actually\s+)?matters\s+(?:is|here)\b/gi,
    fix: "Cut the frame, keep the claim.",
  },
  {
    rule: "worth-frame",
    severity: "hard",
    // "The number worth sitting with is", "the detail worth carrying forward
    // is". A noun, a worthiness clause, then the claim it was delaying.
    re: /\bthe\s+(?:\w+\s+)?(?:number|detail|part|thing|line|figure|fact|question)\s+worth\s+(?:sitting\s+with|carrying\s+forward|watching|noting|reading|holding\s+onto|remembering)\b/gi,
    fix: "Delete the frame and state the number or the detail.",
  },
  {
    rule: "binary-contrast",
    severity: "hard",
    // The uncontracted form the first rule missed: "It is not X. It is Y.",
    // "does not reduce the cost. It changes the constraint."
    re: /\b(?:it|this|that)\s+(?:is|was|does|did)\s+not\s+[^.?!\n]{2,90}\.\s+(?:It|This|That)\s+(?:is|was|does|did|changes|means|becomes)\b/g,
    fix: "State the second sentence on its own. Drop the negated setup.",
  },
  {
    rule: "vague-declarative",
    severity: "hard",
    // stop-slop: announcing importance without naming the thing.
    re: /\bthe\s+(?:reasons?|implications?|stakes|consequences?|problem|answer|shift|change|difference|point)\s+(?:is|are)\s+(?:structural|significant|real|high|deeper|bigger|simple|clear|elsewhere|obvious|more\s+(?:specific|interesting|subtle))\b/gi,
    fix: "Name the specific reason, implication or difference. Or cut the sentence.",
  },
  {
    rule: "telling",
    severity: "hard",
    re: /\bthis\s+is\s+what\s+\w+(?:\s+\w+)?\s+actually\s+looks\s+like\b|\bactually\s+matters\b|\bthis\s+is\s+(?:genuinely\s+)?hard\b/gi,
    fix: "Show the thing instead of announcing that it matters or that it is hard.",
  },
  {
    rule: "fragment-drama",
    severity: "hard",
    re: /\bthat'?s\s+it\.|\bthat'?s\s+the\s+(?:whole\s+)?(?:point|thing|game|story|job|post)\b|\bfull\s+stop\b|(?:^|\s)period\.\s*(?:\n|$)/gi,
    fix: "Performative simplicity. Write the sentence the fragment is standing in for.",
  },
  {
    rule: "false-agency",
    severity: "soft",
    // stop-slop: inanimate things doing human verbs. "The inventory model
    // becomes a flow model." "The market rewards." Someone did something;
    // name them, or put the reader in the seat with "you".
    re: /\b(?:the\s+)?(?:\w+\s+)?(?:model|market|markets|data|decision|culture|conversation|constraint|question|number|cost|story|headline|narrative|industry|bottleneck|moment|rail|rails|ledger|system)\s+(?:becomes?|became|emerges?|rewards?|tells\s+us|shifts?|moves\s+toward|lives\s+or\s+dies|wants?|demands?|decides?|knows?|remembers?|forgives?|punishes)\b/gi,
    fix: "An inanimate subject doing a human verb. Name who acts, or make it 'you'.",
  },
  {
    rule: "so-opener",
    severity: "soft",
    re: /(?:^|\n\n)So,?\s+[a-z]/g,
    fix: "Start the paragraph with content, not 'So'.",
  },
  {
    rule: "faux-insight",
    severity: "hard",
    re: /\b(?:what\s+nobody\s+tells\s+you|nobody\s+talks\s+about|the\s+part\s+(?:everyone|most\s+people)\s+miss(?:es)?|most\s+people\s+get\s+(?:this|it)\s+wrong|what\s+most\s+people\s+(?:miss|get\s+wrong)|here'?s\s+what\s+actually\s+happened)\b/gi,
    fix: "Delete the setup. Let the claim stand on its own.",
  },
  {
    rule: "throat-clearing",
    severity: "hard",
    re: /(?:^|\n)\s*(?:here'?s\s+the\s+thing|here'?s\s+what\s+i\s+mean|let\s+me\s+be\s+clear|i'?ll\s+be\s+honest|to\s+be\s+honest|the\s+uncomfortable\s+truth|let'?s\s+be\s+clear|look,)/gi,
    fix: "Delete the opener and start at the point.",
  },
  {
    rule: "colon-reveal",
    severity: "soft",
    // A short noun phrase, a colon, then a lowercase dramatic reveal. Bounded to
    // 60 chars before the colon so real labels and list headers do not trip it,
    // and a URL after the colon is excluded: "Docs: https://..." and "The BIS
    // laid out the mechanics here: https://..." are citations, not fake drama,
    // and citations are the thing this pillar is built to produce.
    re: /(?:^|\n)[A-Z][^.:!?\n]{0,60}:\s+(?!https?:\/\/|www\.)[a-z][^\n]{10,}/g,
    fix: "Rewrite as a plain sentence. Colons are for lists, labels and quotes.",
  },
  {
    rule: "superficial-analysis",
    severity: "hard",
    re: /,\s+(?:highlighting|underscoring|reflecting|showcasing|signaling|signalling|demonstrating|emphasizing|emphasising|marking|cementing)\b/gi,
    fix: "Replace the trailing clause with the actual consequence.",
  },
  {
    rule: "importance-puffery",
    severity: "hard",
    re: /\b(?:marks?\s+a\s+(?:pivotal|defining|watershed)\s+moment|stands?\s+as\s+a\s+testament|a\s+testament\s+to|plays?\s+a\s+(?:vital|crucial|key)\s+role|solidif(?:y|ies|ying)\s+its\s+position|underscores?\s+(?:its|the)\s+(?:significance|importance)|speaks?\s+volumes)\b/gi,
    fix: "State the fact. Let the reader rank it.",
  },
  {
    rule: "weasel-attribution",
    severity: "hard",
    re: /\b(?:experts?\s+(?:agree|say)|studies\s+show|research\s+shows|industry\s+reports?\s+suggest|many\s+(?:argue|believe)|it\s+is\s+widely\s+(?:regarded|believed)|some\s+say)\b/gi,
    fix: "Name the institution and link it, or cut the claim.",
  },
  {
    rule: "metadiscourse",
    severity: "soft",
    re: /\b(?:that\s+(?:last\s+)?part\s+matters(?:\s+more\s+than\s+it\s+sounds)?|the\s+key\s+point\s+is|this\s+distinction\s+matters|as\s+you\s+can\s+see|in\s+other\s+words|which\s+is\s+to\s+say|the\s+takeaway\s+here)\b/gi,
    fix: "If the point is clear, delete this. If it is not, fix the point.",
  },
  {
    rule: "recap-ending",
    severity: "hard",
    re: /(?:^|\n)\s*(?:in\s+conclusion|ultimately|overall|to\s+sum\s+up|the\s+bottom\s+line|tl;?dr)\b/gi,
    fix: "End on the last concrete point instead. The reader was just there.",
  },
  {
    rule: "rhetorical-setup",
    severity: "hard",
    re: /\b(?:what\s+if\s+i\s+told\s+you|think\s+about\s+it|plot\s+twist|let\s+that\s+sink\s+in|here'?s\s+why\s+that\s+matters)\b/gi,
    fix: "Drop the setup and make the point.",
  },
  {
    rule: "lesson-frame",
    severity: "soft",
    re: /\b(?:the\s+lesson\??|the\s+result\??|the\s+catch\??)\s*[:?]\s*/gi,
    fix: "Write it as a sentence, not a reveal.",
  },
  {
    rule: "feels-like",
    severity: "soft",
    // sloptells: 12x human baseline.
    re: /\b(?:this\s+)?feels\s+like\b|\bone\s+of\s+those\b/gi,
    fix: "Say what it is, not what it feels like.",
  },
  {
    rule: "journey-language",
    severity: "hard",
    re: /\b(?:on\s+(?:a|this|our)\s+journey|the\s+next\s+chapter|our\s+story|this\s+is\s+just\s+the\s+beginning)\b/gi,
    fix: "Cut. Say what shipped.",
  },
  {
    rule: "hedge-pileup",
    severity: "soft",
    re: /\b(?:probably|arguably|somewhat|fairly|relatively|potentially|perhaps|possibly|maybe|likely)\b/gi,
    fix: "One hedge is honest. Three is a model covering itself.",
  },
];

// Hedges are only a finding once they pile up.
const HEDGE_BUDGET = 2;

// ---------------------------------------------------------------------------
// Tier 5, the commodity zone. This tier is about POSITIONING words, not prose
// style, and it is the only tier here sourced from lib/positioning.ts rather
// than from the slop research. It is numbered 5 because Tier 4 in ANTI-SLOP.md
// is rhythm and shape, which is prose guidance and has no regex.
//
// It exists because the positioning brief ASKED for these and nothing CHECKED
// for them. Every other rule Rob cared about is enforced in code, not left as a
// request in a prompt: em dashes are stripped, threads are caught, sources are
// gated. The words Ryne spends the most time on were the one exception, so a
// draft could clear the whole gauntlet still carrying "for agents".
//
// Source: Ryne, all hands 2026-08-31, on top-line messaging ("every single word
// matters"), plus the commodity-zone list already in POSITIONING_BRIEF.
//
// ALL SOFT, deliberately. Hard findings force a repair round trip and can drop
// an option; these are context judgments the operator should make. A curriculum
// post teaching correspondent banking may say "money movement" about the TRADFI
// system and be right to. What Ryne objects to is the phrase as ECO's
// self-description. A regex cannot tell those apart, so it flags and defers.
// ---------------------------------------------------------------------------

const COMMODITY_PHRASES = [
  // "It's shocking how many people had their existing product description and
  // then just literally added two words at the end of it." We signal agent-native
  // orientation through what the product does, never through the phrase.
  // "for agents" alone also catches "built for agents" / "designed for agents",
  // so the longer variants would only double-report the same sentence.
  "for agents", "agent-ready",
  // Unqualified, and therefore not distinctive.
  "money movement", "move money", "moves money", "moving money",
  "the future of payments", "payment rails for the internet",
  "makes money programmable",
  // Worn-out category labels, including the superseded self-description that
  // was still live in three prompt files until 2026-09-01.
  "stablecoin network",
  "the neutral platform organizing the stablecoin market",
];

// The words that sit in the hollow column and the ownable column at the same
// time. Ryne: "you can't just say programmable and trust that people understand
// the implications of that" -- and he notes he made that mistake himself this
// year. So these are not banned, they are GATED: legitimate when the same
// sentence shows the mechanism, empty when it does not.
const SUBSTANTIATION_GATED = [
  "programmable", "programmability", "trusted", "control",
];

// Senses of a gated word that are not the claim Ryne objects to. "Trusted" as a
// self-description is hollow; "a trusted party controls execution" is the
// technical critique we make OF the alternatives, and one of our better product
// posts opens on exactly that line. Measured against the live corpus: without
// this, that post flags and the finding is simply wrong.
const GATED_EXCEPTIONS: Record<string, RegExp> = {
  trusted:
    /\btrusted\s+(party|parties|third[- ]party|intermediary|intermediaries|setup|execution|environment|counterparty|entity|custodian|relayer|oracle)\b/i,
};

// What counts as substantiation, checked inside the same sentence. Crude on
// purpose, in the same spirit as the rest of the regex tiers: it catches the
// bare assertion, and anything fuzzier is left to the model and the operator.
// A number is the strongest signal; a named mechanism is the other honest one.
const SUBSTANTIATION_RE =
  /\d|\b(rule|rules|ruleset|rulesets|parameter|parameters|policy|deadline|slippage|route|routes|routing|solver|solvers|intent|intents|settle|settles|settled|settlement|atomic|atomically|revert|reverts|signature|allowance|permit|endpoint|API|call|calls|quote|quotes|mint|redemption|custody|counterparty)\b/i;

// Sentence split for the gated check. Handles the newline-separated lines an X
// post is actually built from, not just full stops.
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Form. The rules Rob named directly: one post, never a thread, no em dashes.
// ---------------------------------------------------------------------------

const THREAD_MARKERS: PatternRule[] = [
  {
    rule: "thread",
    severity: "hard",
    // "1/", "2/7", "(1/5)", "1 of 5" on their own line or at a line start.
    re: /(?:^|\n)\s*\(?\s*\d{1,2}\s*(?:\/|\s+of\s+)\s*\d{0,2}\s*\)?\s*(?=\n|$|[A-Z"'])/g,
    fix: "Thread numbering. This must be one post.",
  },
  {
    rule: "thread",
    severity: "hard",
    re: /🧵|\bthread\s*(?:below|incoming|:)|\ba\s+thread\s+on\b|\bmore\s+below\b|\bcont(?:'d|inued)?\.?\s*$|\b(?:link|source|details)\s+in\s+(?:the\s+)?(?:reply|replies|comments)\b|\b(?:1|first)\s+of\s+\d+\b/gim,
    fix: "Thread or self-reply signal. One post, everything in it, link included.",
  },
];

const FORM_PATTERNS: PatternRule[] = [
  {
    rule: "markdown",
    severity: "hard",
    re: /\*\*[^*\n]+\*\*|(?:^|\n)#{1,6}\s+\S|(?:^|\n)\s*>\s+\S/g,
    fix: "X renders no markdown. Bold ships as literal asterisks.",
  },
  {
    rule: "emoji-structure",
    severity: "hard",
    // Emoji used as a bullet or section marker at the start of a line.
    re: /(?:^|\n)\s*(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]|✅|❌|🔑|📈|🚀)\s*/gu,
    fix: "Emoji as structure is an AI-only formatting tell. Remove.",
  },
  {
    rule: "bullet-overuse",
    severity: "soft",
    re: /(?:^|\n)\s*[-•*]\s+\S/g,
    fix: "Bullets in conversational text run 13x human baseline. Prose unless it is a real list.",
  },
];

const BULLET_BUDGET = 2;

// ---------------------------------------------------------------------------
// Deterministic fixes. Everything here is a rewrite we are willing to make
// without a human looking, because the correct output is not in question.
// ---------------------------------------------------------------------------

/**
 * Replace em and en dashes with punctuation that carries the same break.
 *
 *   " — "  parenthetical break  ->  ", "
 *   "X—Y"  tight join           ->  "X, Y"
 *   "9–5"  numeric range        ->  "9-5"
 */
export function stripDashes(s: string): string {
  return s
    .replace(/(\d)\s*[—–]\s*(\d)/g, "$1-$2") // ranges keep a hyphen
    .replace(/\s+[—–]\s+/g, ", ")
    .replace(/([^\s])[—–]([^\s])/g, "$1, $2")
    .replace(/[—–]/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*\./g, ".");
}

/** Curly punctuation to straight. Cheap, and straight quotes read as typed. */
function straightenQuotes(s: string): string {
  return s
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...");
}

/**
 * Applied to every draft before it reaches the operator. Only mechanical fixes
 * live here: anything needing judgment is reported by scanSlop() instead.
 */
export function autoFixSlop(text: string): string {
  let out = straightenQuotes(stripDashes(text));

  // Thread numbering, if the model produced it anyway. Strip the marker and
  // keep the content: the result is one long post, which is what we wanted.
  out = out.replace(/(?:^|\n)\s*\(?\s*\d{1,2}\s*(?:\/|\s+of\s+)\s*\d{0,2}\s*\)?\s*(?=\n|$|[A-Z"'])/g, "\n\n");
  out = out.replace(/🧵/g, "");

  // Markdown emphasis and headers: unwrap, do not delete the words.
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  out = out.replace(/(?:^|\n)#{1,6}\s+/g, "\n");

  return out.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
}

/**
 * Run over the ASSEMBLED prompt, not over drafts.
 *
 * The context block pulls strings from taxonomy, products, analogs, icp and
 * pillarShapes, plus article bodies, doc pages and video transcripts straight
 * out of Postgres. Those carry em dashes we cannot police at the source, and a
 * model shown 54 em dashes while being told not to write them will write them.
 * Register words are left alone here: rewriting instruction prose blind would
 * change its meaning, so the authored strings were fixed by hand instead.
 */
export function sanitizePrompt(prompt: string): string {
  return straightenQuotes(stripDashes(prompt));
}

// ---------------------------------------------------------------------------
// The scan.
// ---------------------------------------------------------------------------

function wordRe(w: string): RegExp {
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // \b does not fire around an apostrophe or a leading digit, so anchor on
  // non-word boundaries for multiword phrases.
  return new RegExp(`(?<![\\w'])${esc}(?![\\w'])`, "gi");
}

function push(out: SlopFinding[], f: SlopFinding) {
  // One finding per rule+match, so a word used four times reports once.
  if (out.some((x) => x.rule === f.rule && x.match.toLowerCase() === f.match.toLowerCase())) return;
  out.push(f);
}

/**
 * Check one draft against the house standard.
 * Ordered hard findings first, since that is the order they get fixed in.
 */
export function scanSlop(text: string): SlopFinding[] {
  const out: SlopFinding[] = [];
  if (!text) return out;

  // --- Form ---
  for (const d of text.match(/[—–]/g) ?? []) {
    push(out, {
      rule: "em-dash",
      severity: "hard",
      match: d,
      fix: "No em dashes. Use a comma, a colon, a full stop, or a plain hyphen.",
    });
  }

  for (const p of [...THREAD_MARKERS, ...FORM_PATTERNS]) {
    const hits = text.match(p.re) ?? [];
    if (!hits.length) continue;
    if (p.rule === "bullet-overuse" && hits.length <= BULLET_BUDGET) continue;
    push(out, { rule: p.rule, severity: p.severity, match: (hits[0] ?? "").trim().slice(0, 60), fix: p.fix });
  }

  // --- Words ---
  for (const w of [...BANNED_WORDS, ...BANNED_PHRASES]) {
    const m = text.match(wordRe(w));
    if (m) push(out, { rule: "banned-word", severity: "hard", match: m[0], fix: `"${m[0]}" is banned outright. Rewrite the sentence around the fact.` });
  }

  for (const w of BAIT_PHRASES) {
    const m = text.match(wordRe(w));
    if (m) push(out, { rule: "engagement-bait", severity: "hard", match: m[0], fix: "Earn the reply with a claim worth arguing with. Never ask for it." });
  }

  for (const j of JARGON) {
    const m = text.match(wordRe(j.word));
    if (m) push(out, { rule: "jargon", severity: "soft", match: m[0], fix: `Business jargon. Plainer: ${j.plain}.` });
  }

  // --- Tier 2 register budget ---
  const registerHits: string[] = [];
  for (const w of REGISTER_WORDS) {
    const m = text.match(wordRe(w));
    if (m) registerHits.push(m[0]);
  }
  if (registerHits.length > REGISTER_BUDGET) {
    push(out, {
      rule: "register-budget",
      severity: "hard",
      match: registerHits.join(", "),
      fix: `${registerHits.length} words from the 2026 agent register (budget is ${REGISTER_BUDGET}). Keep the one doing real work, replace the rest with plainer words.`,
    });
  }

  // --- Tier 3 patterns ---
  for (const p of PATTERNS) {
    const hits = text.match(p.re) ?? [];
    if (!hits.length) continue;
    if (p.rule === "hedge-pileup" && hits.length <= HEDGE_BUDGET) continue;
    push(out, { rule: p.rule, severity: p.severity, match: (hits[0] ?? "").trim().slice(0, 60), fix: p.fix });
  }

  // --- Tier 6 structure (stop-slop) ---
  for (const f of structureFindings(text)) push(out, f);

  // --- Tier 5 commodity zone ---
  for (const w of COMMODITY_PHRASES) {
    const m = text.match(wordRe(w));
    if (m) {
      push(out, {
        rule: "commodity-zone",
        severity: "soft",
        match: m[0],
        fix: `"${m[0]}" is in the crowded/meaningless column (Ryne, all hands 2026-08-31). It is not distinctive on its own. Say the specific thing Eco does instead, or qualify it in the same sentence.`,
      });
    }
  }

  for (const w of SUBSTANTIATION_GATED) {
    // wordRe is global, so lastIndex would persist across .test() calls.
    const probe = new RegExp(wordRe(w).source, "i");
    const except = GATED_EXCEPTIONS[w];
    const bare = sentencesOf(text).find(
      (sent) =>
        probe.test(sent) &&
        !SUBSTANTIATION_RE.test(sent) &&
        !(except && except.test(sent)),
    );
    if (bare) {
      push(out, {
        rule: "unsubstantiated",
        severity: "soft",
        match: w,
        fix: `"${w}" is hollow unqualified and ownable when explained. This sentence carries neither a number nor a named mechanism: "${bare.slice(0, 80)}". Show what makes it true in the same sentence, or cut the word.`,
      });
    }
  }

  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "hard" ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Tier 6, structure. From the stop-slop skill, 2026-10-16.
//
// These are the tells that survive a word list. A week of pipeline drafts had
// no banned words, one register word apiece, no em dashes, and still read as
// one voice: "X, not Y" closing four sentences in a post, every paragraph
// landing on a four-word line, three sentences in a row of fifteen words, the
// subject of every sentence a noun doing a verb ("the model becomes a flow
// model"). None of that is a phrase. It is counted, not matched.
//
// Budgets, not bans, because each of these is fine ONCE. Twice is the pattern.
// ---------------------------------------------------------------------------

const TRAILING_CONTRAST_BUDGET = 1; // "X, not Y." / "X rather than Y"
const WH_OPENER_BUDGET = 1; // statements starting What/When/Where/Which/Who/Why/How
const EXTREME_BUDGET = 1; // every / always / never / everyone / nobody
const ADVERB_BUDGET = 2; // -ly words
const PUNCHY_ENDING_BUDGET = 1; // paragraphs ending on a line of six words or fewer

// -ly words that are not adverbs, or are adverbs nobody reads as emphasis.
const LY_ALLOW = new Set([
  "only", "early", "daily", "weekly", "monthly", "quarterly", "yearly", "hourly", "family",
  "supply", "apply", "reply", "rally", "ally", "italy", "july", "assembly", "anomaly",
  "holy", "ugly", "friendly", "costly", "deadly", "lonely", "timely", "lively", "likely",
  "unlikely", "orderly", "fly", "rely", "multiply", "comply", "imply", "belly", "jelly",
  "bully", "tally", "silly", "chilly", "hilly", "jolly", "folly", "dolly", "fully",
]);

function words(s: string): string[] {
  return s.match(/[A-Za-z$][\w$%.,-]*/g) ?? [];
}

function structureFindings(text: string): SlopFinding[] {
  const out: SlopFinding[] = [];
  // Paragraphs and sentences, with URLs and bullet lines dropped: a bare link
  // on its own line is not a punchy ending, a URL is not a word, and the items
  // of a real list are not three stacked sentences.
  const body = text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/(?:^|\n)\s*[-•*↳]\s+[^\n]*/g, "\n")
    .trim();
  const paragraphs = body.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  const sentences = sentencesOf(body);

  // "X, not Y." and "rather than". The mechanical contrast the first three
  // sources only listed in its "it's not X, it's Y" form.
  const trailing = body.match(/,\s+not\s+(?:a|an|the|just|only|merely)?\s*[\w$%-]+(?:\s+[\w$%-]+){0,4}(?=[.;!?\n]|$)/g) ?? [];
  const rather = body.match(/\brather\s+than\b/gi) ?? [];
  const contrasts = trailing.length + rather.length;
  if (contrasts > TRAILING_CONTRAST_BUDGET) {
    out.push({
      rule: "trailing-contrast",
      severity: "hard",
      match: (trailing[0] ?? rather[0] ?? "").trim().slice(0, 60),
      fix: `${contrasts} "X, not Y" / "rather than" contrasts (budget ${TRAILING_CONTRAST_BUDGET}). State Y on its own in all but one.`,
    });
  }

  // Wh- openers on statements. Questions are allowed: a real question is one
  // of the few things on this platform that earns a reply.
  const wh = sentences.filter((x) => /^(?:What|When|Where|Which|Who|Why|How)\b/.test(x) && !/\?\s*$/.test(x));
  if (wh.length > WH_OPENER_BUDGET) {
    out.push({
      rule: "wh-opener",
      severity: "soft",
      match: wh[0].slice(0, 60),
      fix: `${wh.length} statements open on a Wh- word. Lead with the subject: "The constraint is", not "What makes this hard is".`,
    });
  }

  // Lazy extremes. "every corridor", "no individual bank", "never".
  const extremes = body.match(/\b(?:every|always|never|everyone|everybody|nobody|no\s+one|all\s+of\s+them)\b/gi) ?? [];
  if (extremes.length > EXTREME_BUDGET) {
    out.push({
      rule: "lazy-extremes",
      severity: "soft",
      match: extremes.join(", ").slice(0, 60),
      fix: `${extremes.length} sweeping words (budget ${EXTREME_BUDGET}). Replace with the specific count or case.`,
    });
  }

  // Adverbs. The skill kills all of them; the budget here is two, because
  // "directly" in "settles directly into the account" is doing work.
  const ly = words(body)
    .map((w) => w.toLowerCase().replace(/[^a-z]/g, ""))
    .filter((w) => w.length > 4 && w.endsWith("ly") && !LY_ALLOW.has(w));
  const lyUnique = [...new Set(ly)];
  if (ly.length > ADVERB_BUDGET) {
    out.push({
      rule: "adverb-pileup",
      severity: "soft",
      match: lyUnique.slice(0, 5).join(", "),
      fix: `${ly.length} adverbs (budget ${ADVERB_BUDGET}). Cut them; if the verb needs help, pick a better verb.`,
    });
  }

  // Punchy endings: a paragraph of two or more sentences that lands on a line
  // of six words or fewer. Once is a beat. Twice is the metronome.
  const punchy = paragraphs.filter((p) => {
    const ss = sentencesOf(p);
    return ss.length >= 2 && words(ss[ss.length - 1]).length <= 6;
  });
  if (punchy.length > PUNCHY_ENDING_BUDGET) {
    const last = sentencesOf(punchy[0]);
    out.push({
      rule: "punchy-endings",
      severity: "soft",
      match: last[last.length - 1].slice(0, 60),
      fix: `${punchy.length} paragraphs end on a short punchy line. Vary the endings; let one paragraph end mid-thought.`,
    });
  }

  // Staccato: three consecutive sentences of six words or fewer. SOFT, against
  // the skill's instinct: the pillar's third-best post ever ("Not one chain.
  // Eight. Not one stablecoin. Six.", 3.3k impressions) is exactly this shape,
  // done on purpose by a person. Surfaced so the operator sees it; not a veto.
  const lens = sentences.map((x) => words(x).length);
  for (let i = 0; i + 2 < lens.length; i++) {
    if (lens[i] <= 6 && lens[i + 1] <= 6 && lens[i + 2] <= 6) {
      out.push({
        rule: "staccato",
        severity: "soft",
        match: sentences.slice(i, i + 3).join(" ").slice(0, 60),
        fix: "Three short sentences stacked for drama. Join two of them.",
      });
      break;
    }
  }

  // Metronome: three consecutive sentences within three words of each other,
  // all in the 10-24 band. The measured signature of model prose.
  for (let i = 0; i + 2 < lens.length; i++) {
    const run = lens.slice(i, i + 3);
    if (run.every((n) => n >= 10 && n <= 24) && Math.max(...run) - Math.min(...run) <= 3) {
      out.push({
        rule: "metronome",
        severity: "soft",
        match: `${run.join("/")} words`,
        fix: "Three sentences of the same length in a row. Make one four words long or thirty.",
      });
      break;
    }
  }

  return out;
}

export function hardFindings(f: SlopFinding[]): SlopFinding[] {
  return f.filter((x) => x.severity === "hard");
}

// ---------------------------------------------------------------------------
// When to spend a repair round-trip, and whether a repair was worth keeping.
//
// Until 2026-10-16 only a HARD finding triggered the repair. That let a draft
// through with five soft structural findings, which is exactly the draft Rob
// described as "consistently falling into patterns of ai slop phrasing and
// structure": nothing on it was individually wrong, and together it was a
// voice. So a pile of soft findings now earns the repair pass too.
// ---------------------------------------------------------------------------
export const SOFT_REPAIR_THRESHOLD = 3;

export function needsRepair(f: SlopFinding[]): boolean {
  return hardFindings(f).length > 0 || f.length >= SOFT_REPAIR_THRESHOLD;
}

/** True when `after` is a strict improvement on `before`: fewer hard findings, or the same hard count and fewer in total. */
export function repairImproved(before: SlopFinding[], after: SlopFinding[]): boolean {
  const hb = hardFindings(before).length;
  const ha = hardFindings(after).length;
  if (ha < hb) return true;
  return ha === hb && after.length < before.length;
}

/** Compact, one line per finding, for a repair prompt. */
export function findingsForRepair(f: SlopFinding[]): string {
  return f.map((x) => `  [${x.severity}] ${x.rule}: "${x.match}" -> ${x.fix}`).join("\n");
}

// ---------------------------------------------------------------------------
// Length. Threads are banned, so length is the only structural variable left,
// and the mix across the three returned options is the point. Without this the
// drafter converges on one band and the account drifts all-short or all-long.
// ---------------------------------------------------------------------------

export interface LengthBand {
  id: "tight" | "mid" | "long";
  label: string;
  chars: string;
  when: string;
}

export const LENGTH_BANDS: LengthBand[] = [
  {
    id: "tight",
    label: "Tight",
    chars: "under 280 characters",
    when: "One number, one claim, one mechanism. Right when something else carries the payload: an animation, a quote card, a clip, a chain going live.",
  },
  {
    id: "mid",
    label: "Mid",
    chars: "400 to 900 characters",
    when: "A claim, the mechanism under it, and the source. The workhorse for product posts and thought leadership.",
  },
  {
    id: "long",
    label: "Long form",
    chars: "900 to 2000 characters",
    when: "Only when the material has steps: a mechanism that needs sequence, a curriculum parallel and its break, an argument that handles a real objection. Long form earns dwell, and a long thin post is the most punishable object on the platform.",
  },
];

/** The FORM block. Handed to the drafter on every call, before anything else. */
export function formBlock(): string {
  return [
    "FORM, this overrides every other instruction about shape:",
    "  ONE POST. Never a thread. No 1/, no 2/7, no thread emoji, no 'more below',",
    "  no 'link in reply', no numbered run of paragraphs that reads as split posts.",
    "  Everything goes in one post, link included. There is no link penalty in the",
    "  algorithm and open_link pays +0.2, so the reader gets the source where they",
    "  are already reading.",
    "",
    "  Long form inside that one post is allowed and often better. Dwell is the base",
    "  quantity in the ranking, and a long post holds it where a thread splits it.",
    "  Long form is never the automatic choice: it is earned by having the material.",
    "",
    "  LENGTH MIX. Assign the bands BEFORE you write, one per option. Do not decide",
    "  the length as you go: left to itself every draft lands long, and three long",
    "  drafts is a failed set even when each one is good.",
    ...LENGTH_BANDS.map((b) => `    ${b.label} (${b.chars}). ${b.when}`),
    "",
    "    OPTION 1 = the band this pillar names as its default, above.",
    "    OPTION 2 = a different band.",
    "    OPTION 3 = the remaining band.",
    "  Start each rationale with the band name, so the assignment is visible.",
    "",
    "  Never pad to reach a band. If the material cannot carry the long version, write",
    "  the short one and say so in the rationale. A long thin post is the most",
    "  punishable object on the platform: dwell without payoff is scored against you.",
  ].join("\n");
}

/** The rules block. Compact on purpose: the CLI backend has a 300s ceiling. */
export function antiSlopBlock(): string {
  return ANTI_SLOP_BRIEF;
}

export const ANTI_SLOP_BRIEF = `
ANTI-SLOP STANDARD (house rules, checked in code after you return; a draft that
fails the mechanical checks is rejected, so write it clean the first time)

THE TEST UNDERNEATH ALL OF IT
Slop is writing that survives being moved. Lift any sentence out and drop it into
a post about a different company, in a different market, on a different day. If it
still reads fine, it was carrying nothing. Cut it or replace it with a number, a
named system, a dated fact, or a claim someone could argue with.
This account has a second problem: Eco's voice is precise and institutional, which
is the same register current models write in. Sounding rigorous is not evidence of
being human. The number is.

HARD BANS, mechanical
- NO EM DASHES OR EN DASHES. Anywhere, including as a bullet marker. Use a comma,
  a colon, a full stop, or a plain hyphen.
- NO MARKDOWN. X renders none of it. Bold ships as literal asterisks. No headers,
  no blockquotes, no bold mid-sentence.
- NO EMOJI AS STRUCTURE. Not as bullets, not as section markers.
- NO ENGAGEMENT BAIT. No "curious what others think", no "thoughts?", no "who
  else". A reply is worth 5.0 and is earned with a claim, never requested. A
  report is -234 and a mute -58.8.
- BULLETS ONLY FOR A REAL LIST of parallel items. Bullets in conversational text
  run 13x human baseline. Two sentences of prose beat three bullets.

BANNED WORDS
delve, foster, leverage, utilize, facilitate, empower, streamline, robust,
cutting-edge, paradigm shift, game changer, tapestry, realm, beacon, multifaceted,
meticulous, intricate, paramount, transformative, elevate, embark, supercharge,
harness, ever-evolving, seamless, unlock, GENUINELY.

BANNED PHRASES
it's worth noting, it's important to note, at the end of the day, when it comes to,
at its core, in today's world, in the age of, the reality is, the truth is, in
terms of, going forward, let's dive in, that said, here's the thing, here's the
kicker, no fluff, thrilled/excited/humbled to announce, this is huge, this changes
everything.

THE 2026 REGISTER BUDGET, the one that matters most for this account
These words are the measured vocabulary of current models, not of people writing
about markets. Not one of them is a bad word. AT MOST ONE per post, and only when
no plainer word does the job:
load-bearing, plainly, quietly, deliberately, merely, precisely, structurally,
empirically, materially, outright, nobody, honestly, asymmetry, premise,
chokepoint, backstop, tripwire, machinery, substrate, ratchet, vacuous,
indistinguishable, verbatim, orthogonal, latent, rests on, refuses, asserts.

CONSTRUCTIONS TO CUT
- Binary contrast. "It's not X, it's Y." "The question isn't X, it's Y." "Not
  because X. Because Y." State Y. Example: "This isn't a bridge, it's a routing
  layer" becomes "Eco routes and settles the whole flow atomically. A bridge moves
  one hop."
- "The real question is", "the actual problem is", "what actually matters".
- Faux-insight setups: "what nobody tells you", "the part everyone misses".
- Colon reveals: a noun phrase, a colon, a lowercase dramatic reveal. Write the
  sentence instead.
- Throat-clearing openers: "Here's the thing", "Let me be clear".
- Trailing -ing analysis: "highlighting", "underscoring", "reflecting",
  "showcasing", "signaling". Replace with the actual consequence.
- Importance puffery: "marks a pivotal moment", "a testament to", "plays a vital
  role". State the fact and let the reader rank it.
- Weasel attribution: "experts agree", "studies show", "industry reports suggest".
  Name the institution or cut the claim.
- Metadiscourse: "the key point is", "that matters more than it sounds", "in other
  words". If the point is clear, delete it.
- Mic-drop closers. Delete the final profound line, do not improve it. End on the
  last concrete sentence or the part that is still open.
- Recap endings: "In conclusion", "Ultimately", "Overall". The reader was just
  there.
- Negative listing ("Not a bridge. Not a swap tool. A routing layer."). Say the
  last one.
- Synonym cycling. If "routing" is the right word, use it three times. Rotating to
  "orchestration" is also how a draft accidentally adopts a category we refuse.
- Hedge pileup. One hedge is honest, three is a model covering itself.
- Vague declaratives: "the reasons are structural", "the implications are
  significant", "the underlying problem is more specific". Name the reason.
- "The number worth sitting with is", "the detail worth carrying forward is".
  State the number.
- Telling instead of showing: "this is what X actually looks like", "actually
  matters", "this is genuinely hard".
- Dramatic fragments: "That's it. That's the post." "Full stop."

STRUCTURE (stop-slop; counted in code, budgets not bans)
- ACTIVE VOICE, NAMED ACTORS. No passive. No inanimate thing doing a human verb:
  "the inventory model becomes a flow model", "the market rewards", "the data
  tells us". A bank, a treasurer, an issuer, or "you" did something. Say who.
- "X, not Y" AT MOST ONCE per post, "rather than" included. "In production, not
  announced", "optional, not structural", "timing rather than inventory" in one
  post is a tic. State Y on its own.
- NO Wh- OPENERS on statements. "When settlement rails are live, prefunding..."
  becomes "Live settlement rails make prefunding optional." Real questions that
  end in ? are fine.
- NO LAZY EXTREMES. "every corridor", "never", "nobody", "no individual bank".
  Use the count or the case.
- ADVERBS OUT. At most two -ly words in the post, and only when the verb needs
  them. "Settles directly" can stay. "Incrementally" goes.
- NO PUNCHY PARAGRAPH ENDINGS as a habit. One paragraph may land on a short
  line. Two is the metronome. Let a paragraph end mid-thought.
- NO STACKED FRAGMENTS. Three sentences under six words in a row is drama.
- VARY SENTENCE LENGTH. Three sentences in a row of the same length is the
  measured signature of model prose. Put a four-word sentence next to a
  thirty-word one.
- TWO ITEMS BEAT THREE. Three parallel examples is the model's default count.
- PUT THE READER IN THE ROOM. "You" beats "people" and "operators". "You park
  capital in every corridor you serve" beats "a bank parks capital".
- NO JARGON: navigate, unpack, lean into, landscape, double down, deep dive,
  moving forward, circle back, take a step back, on the same page.
- NO META-COMMENTARY: "hint:", "spoiler:", "feature, not a bug", "dressed up
  as", "you already know this", "but that's another post", "I promise".

RHYTHM
Slop has a metronome: every sentence 12 to 18 words, every paragraph three
sentences, every paragraph ending on a punchy line. Be lumpy. Put a four-word
sentence next to a thirty-word one because the argument needs it. Two examples
usually beat three. Land hard in one place, not five.

WHAT IS NOT BANNED, do not over-correct into flatness
Contractions, fragments, an aside, a blunt opinion, a long sentence that is clear,
repeating the right word. "not just X", "in practice" and "especially" are fine in
moderation. The goal is copy that sounds like a specific person at a specific
company on a specific day, not copy sanded until nothing catches.
`.trim();
