// Quote extraction — spec §6.3 (two-pass) and §8 (the prompt contract).
//
// Gemini does all comprehension. Two passes on purpose:
//   Pass 1 — diarized transcript from the VIDEO, persisted to raw_documents.
//   Pass 2 — quote extraction over the persisted TEXT.
// Splitting them is the difference between a rubric change costing pennies and
// costing a full re-ingest of every video.

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Two models on purpose. Reading VIDEO is a paid-tier capability and only the
// 3.x line does it — 2.5-flash accepts a YouTube fileUri and silently ignores
// it (see VideoNotIngestedError below). Pass 2 runs over plain TEXT, where the
// cheaper model is fine and is most of the volume.
//
// Both are env-overridable because Google retires model ids on a short cycle:
// gemini-2.5-pro and gemini-2.0-flash were both already gone by the time this
// was written, and hardcoding cost a debugging session.
const VIDEO_MODEL = process.env.GEMINI_VIDEO_MODEL || "gemini-3.6-flash";
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";

// Video-capable models to fall back through when the primary is saturated.
// Observed in practice: gemini-3.6-flash returns 503 "experiencing high demand"
// on a 12-minute clip as readily as on a 72-minute one, so this is capacity,
// not video length — and 503/429 are explicitly transient.
//
// EVERY MODEL LISTED HERE MUST ACTUALLY READ VIDEO. gemini-3-flash-preview was
// briefly in this list and is the reason for the warning: it returns HTTP 200
// for a request carrying a YouTube fileUri, then answers from the text prompt
// alone (promptTokenCount=0, "you haven't included a video"). Falling back to a
// model that succeeds WITHOUT doing the job is worse than failing outright —
// only the ingestion gate below stopped it becoming fabricated quotes.
const VIDEO_FALLBACKS = (process.env.GEMINI_VIDEO_FALLBACKS || "gemini-3.7-flash,gemini-3.5-flash")
  .split(",").map((m) => m.trim()).filter(Boolean);

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function apiKey(): string {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error("GEMINI_API_KEY is not set");
  return k;
}

export interface Segment {
  speaker_label: string;
  speaker_name: string | null;
  start_sec: number;
  end_sec: number;
  text: string;
}

// How we know a named person said this. The end-to-end run made the need for
// this obvious: pointed at a Visa research post, the extractor happily returned
// the article's own body prose ("For instance, instead of requiring a custom new
// ERC-20 token…") attributed to its three-person byline. That is publication
// copy, not a quote, and "Mustafa Bedawala, Mert Ozbay, and Catherine Gu" is a
// byline, not a speaker. Neither belongs on a quote card.
export type AttributionBasis =
  | "quoted"   // inside quotation marks in the source, attributed to a named person
  | "spoken"   // an utterance in a diarized transcript
  | "authored"; // the named person's own first-person writing (their X post, their signed op-ed)

export interface RawCandidate {
  quote_text: string;
  speaker_name: string | null;
  attribution_basis: AttributionBasis | null;
  speaker_title_as_stated: string | null;
  org_as_stated: string | null;
  start_sec: number | null;
  context_before: string | null;
  context_after: string | null;
  topic_tags: string[];
  self_contained: boolean;
  single_claim: boolean;
  pillar_tag: string | null;
}

interface GeminiPart {
  text?: string;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  file_data?: { file_uri: string };
}

export class VideoNotIngestedError extends Error {
  readonly promptTokens: number;
  constructor(promptTokens: number, detail: string) {
    super(`Gemini did not ingest the video (promptTokenCount=${promptTokens}). ${detail}`);
    this.name = "VideoNotIngestedError";
    this.promptTokens = promptTokens;
  }
}

interface GeminiReply {
  text: string;
  promptTokens: number;
}

async function gemini(parts: GeminiPart[], opts: { lowRes?: boolean; model?: string } = {}): Promise<GeminiReply> {
  const body: Record<string, unknown> = {
    contents: [{ parts }],
    generationConfig: { temperature: 0, responseMimeType: "application/json" },
  };
  // Podcasts and panels carry their signal in the audio. Frame detail is wasted
  // tokens and roughly an order of magnitude of cost.
  if (opts.lowRes) body.generationConfig = { ...(body.generationConfig as object), mediaResolution: "MEDIA_RESOLUTION_LOW" };

  // Try the requested model, then each fallback, retrying transient failures
  // with backoff. Without this a single capacity spike fails the whole lane.
  const chain = opts.model ? [opts.model, ...VIDEO_FALLBACKS.filter((m) => m !== opts.model)] : [TEXT_MODEL];
  let lastErr = "";
  let data: { candidates?: { content?: { parts?: GeminiPart[] } }[]; usageMetadata?: { promptTokenCount?: number } } | null = null;
  let usedModel = chain[0];

  outer: for (const model of chain) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${apiKey()}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(280_000),
      });
      if (res.ok) {
        data = await res.json();
        usedModel = model;
        break outer;
      }
      lastErr = `${model} ${res.status}: ${(await res.text()).slice(0, 200)}`;
      if (!RETRYABLE.has(res.status)) break; // 403/400 won't improve by waiting — next model
      await sleep(2000 * 2 ** attempt); // 2s, 4s, 8s
    }
  }
  if (!data) throw new Error(`Gemini exhausted ${chain.length} model(s): ${lastErr}`);
  void usedModel;
  const text = data?.candidates?.[0]?.content?.parts?.map((p: GeminiPart) => p.text ?? "").join("") ?? "";
  return { text, promptTokens: Number(data?.usageMetadata?.promptTokenCount ?? 0) };
}

function parseJson<T>(raw: string, fallback: T): T {
  let t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const s = t.indexOf("[") !== -1 && (t.indexOf("[") < t.indexOf("{") || t.indexOf("{") === -1) ? "[" : "{";
  const e = s === "[" ? t.lastIndexOf("]") : t.lastIndexOf("}");
  const start = t.indexOf(s);
  if (start === -1 || e === -1) return fallback;
  try {
    return JSON.parse(t.slice(start, e + 1)) as T;
  } catch {
    return fallback;
  }
}

// --- Pass 1: diarized transcript from a YouTube URL -------------------------

// Misattribution on a multi-guest podcast is the failure mode that quietly
// poisons the queue, so the expected participants are passed in and the model is
// told to return null rather than guess. A segment with a null speaker can never
// produce a candidate.
export async function transcribeVideo(
  youtubeUrl: string,
  expectedParticipants: string[],
  durationSec?: number | null,
): Promise<Segment[]> {
  const prompt = [
    "Produce a diarized transcript of this video.",
    expectedParticipants.length
      ? `Expected participants (map speaker labels to these real names where you can):\n${expectedParticipants.map((p) => `- ${p}`).join("\n")}`
      : "No participant list was supplied.",
    "",
    "Rules:",
    "- Transcribe VERBATIM. Do not clean up filler words, false starts, or grammar.",
    "- If you cannot confidently identify who is speaking, set speaker_name to null. NEVER guess a name.",
    "  Attributing one company's executive to another is the worst outcome here; a null is free.",
    "",
    'Return JSON only: [{"speaker_label":"S1","speaker_name":"Full Name or null","start_sec":0,"end_sec":0,"text":"…"}]',
  ].join("\n");

  const reply = await gemini(
    [{ file_data: { file_uri: youtubeUrl } }, { text: prompt }],
    { lowRes: true, model: VIDEO_MODEL },
  );

  // ---- The anti-hallucination gate. -------------------------------------
  // A model that cannot actually read the video will still cheerfully return a
  // plausible transcript. Observed for real: gemini-2.5-flash ACCEPTS a YouTube
  // fileUri (a malformed one 400s, so the part is parsed), then contributes
  // ZERO tokens from it and invents an interview out of the participant name.
  // Two identical calls fabricated two different openings, one naming a person
  // who has nothing to do with the video.
  //
  // Verification (§9) cannot catch this: it checks a quote against the
  // transcript, and here the transcript is the thing that was invented — the
  // check is circular. So the only place to stop it is here, and the signal is
  // the token count. Even a few minutes of low-resolution audio costs thousands
  // of prompt tokens; a couple of hundred means only the text prompt was read.
  const MIN_PROMPT_TOKENS = 2000;
  if (reply.promptTokens < MIN_PROMPT_TOKENS) {
    throw new VideoNotIngestedError(
      reply.promptTokens,
      `Only the text prompt was counted, so any transcript returned would be invented. ` +
        `Check that this API key/model tier supports YouTube fileUri input.`,
    );
  }

  const segs = parseJson<Segment[]>(reply.text, []);
  const list = Array.isArray(segs)
    ? segs
        .filter((s) => s && typeof s.text === "string")
        .map((s) => ({
          speaker_label: String(s.speaker_label ?? "S?"),
          speaker_name: s.speaker_name ? String(s.speaker_name) : null,
          start_sec: Number(s.start_sec ?? 0),
          end_sec: Number(s.end_sec ?? 0),
          text: String(s.text),
        }))
    : [];

  // A real diarized pass advances through the video. Every segment stamped at
  // 0s is the shape a fabricated transcript takes, and it also means no deep
  // link could land on the moment even if the content were real.
  if (list.length > 3 && list.every((s) => s.start_sec === 0)) {
    throw new VideoNotIngestedError(
      reply.promptTokens,
      "Every segment is stamped at 0s — the transcript is not a real timed pass over the video.",
    );
  }

  // Timestamps drift long. On a 724-second clip the model returned segments
  // stamped out to 1118s — 54% past the end. A deep link built from that lands
  // after the video finishes, which fails the one thing the reviewer needs the
  // link to do. Rescale proportionally when the overrun is systematic, then
  // clamp, so links land close to the right moment instead of off the end.
  if (durationSec && durationSec > 0 && list.length) {
    const maxT = Math.max(...list.map((s) => s.end_sec || s.start_sec));
    if (maxT > durationSec * 1.05) {
      const scale = durationSec / maxT;
      for (const seg of list) {
        seg.start_sec = Math.min(durationSec, Math.round(seg.start_sec * scale));
        seg.end_sec = Math.min(durationSec, Math.round(seg.end_sec * scale));
      }
    } else {
      for (const seg of list) {
        seg.start_sec = Math.min(durationSec, seg.start_sec);
        seg.end_sec = Math.min(durationSec, seg.end_sec);
      }
    }
  }

  return list;
}

// --- Pass 2: quote extraction over persisted TEXT ---------------------------

const EXTRACTION_RULES = [
  "You extract QUOTABLE, VERBATIM statements about the stablecoin market for a quote card.",
  "",
  "A QUOTE CARD shows one sentence in quotation marks next to ONE named person's face, name and title.",
  "So the only thing that qualifies is something a SPECIFIC NAMED HUMAN said or wrote in their own voice.",
  "",
  "attribution_basis — required on every candidate. Set it to exactly one of:",
  '  "quoted"   — the text sits inside quotation marks in the source and is attributed to a named person',
  '               ("...," said Jane Doe, CFO of Acme).',
  '  "spoken"   — the text is an utterance by an identified speaker in a transcript.',
  '  "authored" — the text is the named person\'s OWN first-person writing: their post, their signed op-ed.',
  "",
  "NOT a quote, no matter how good the sentence is:",
  "  - body prose from an article, report or blog post written in the publication's institutional voice.",
  "    A research paper explaining its own findings is the ORGANISATION talking, not a person.",
  "  - anything whose only attribution is a byline. A byline is who wrote the piece, not who said the line.",
  "  - marketing copy, headings, captions, bullet points, FAQ questions.",
  "  If you cannot point at a specific human who uttered or personally authored the sentence, skip it.",
  "",
  "speaker_name must be ONE person. Never a list, never 'and', never a team or a company.",
  "If a sentence is credited to several authors, there is no single speaker — skip it.",
  "",
  "Rules — all are hard requirements:",
  "1. VERBATIM only. Never clean up filler words. Never stitch non-adjacent sentences together with an ellipsis.",
  "   The text you return will be string-matched against the source; anything you altered will fail and be discarded.",
  "2. Return null for any field not stated in the source. Never infer a title or an employer.",
  "3. Reject internally anything under 8 words or over 55 words.",
  "4. self_contained = false if the quote opens with a dangling pronoun (it, that, this, they) whose referent is outside the quote.",
  "5. single_claim = false if the quote makes more than one distinct assertion. Multi-claim quotes do not fit on a card.",
  "6. Extract AT MOST 5 candidates from this source. Forcing selectivity here beats filtering slop downstream.",
  "7. If nobody is identifiable as the speaker, return an empty list rather than an unattributed quote.",
  "",
  "pillar_tag — which of Eco's four narrative pillars the quote serves, or null:",
  '  "A" — stablecoins winning is settled; the argument has moved on to who connects the economy they build.',
  '  "B" — primary + secondary markets: mint access, on-chain liquidity, off-chain RFQ as one picture.',
  '  "C" — the five-layer stack (issuers, rails, orchestrators, custody/fund mgmt, apps) and where it consolidates.',
  '  "D" — defensibility / category creation: liquidity network effects, data and pricing superiority.',
  "",
  "Return JSON only, an array, no prose, no code fences:",
  '[{"quote_text":"…","speaker_name":"…|null","attribution_basis":"quoted|spoken|authored",',
  ' "speaker_title_as_stated":"…|null","org_as_stated":"…|null",',
  ' "start_sec":0,"context_before":"~200 chars","context_after":"~200 chars","topic_tags":["settlement"],',
  ' "self_contained":true,"single_claim":true,"pillar_tag":"A|B|C|D|null"}]',
].join("\n");

// Which attribution bases are legitimate for a given source kind. An article
// can only yield a QUOTED statement — its own prose is the publisher talking.
// An X post is the account holder's own writing, so "authored" is exactly right
// there and nowhere else on the web.
const ALLOWED_BASIS: Record<string, AttributionBasis[]> = {
  x_post: ["authored", "quoted"],
  youtube: ["spoken", "quoted"],
  article: ["quoted"],
  report: ["quoted"],
};

// A quote card carries one face and one name. "Mustafa Bedawala, Mert Ozbay, and
// Catherine Gu" is a byline; there is no single speaker to attribute to.
export function isSingleNamedPerson(name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  if (/\b(and|&)\b/i.test(n)) return false;
  if ((n.match(/,/g) ?? []).length > 0) return false;
  if (/\b(team|staff|research|group|desk|editors?|contributors?)\b/i.test(n)) return false;
  const words = n.split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  return true;
}

export async function extractQuotes(
  body: string,
  meta: { title?: string | null; sourceKind: string; knownSpeakers?: string[] },
): Promise<RawCandidate[]> {
  const header = [
    EXTRACTION_RULES,
    "",
    `Source kind: ${meta.sourceKind}`,
    meta.title ? `Source title: ${meta.title}` : null,
    meta.knownSpeakers?.length ? `Known speakers in this source: ${meta.knownSpeakers.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const reply = await gemini([{ text: `${header}\n\nSOURCE:\n"""${body.slice(0, 400_000)}"""` }]);
  const list = parseJson<RawCandidate[]>(reply.text, []);
  if (!Array.isArray(list)) return [];
  const allowed = ALLOWED_BASIS[meta.sourceKind] ?? ["quoted"];
  return list
    .filter((c) => c && typeof c.quote_text === "string" && c.quote_text.trim().length > 0)
    // Enforce the contract in code. The prompt asks for these rules; this is
    // what makes them true even when the model is agreeable but wrong.
    .filter((c) => !!c.speaker_name && isSingleNamedPerson(String(c.speaker_name)))
    .filter((c) => !!c.attribution_basis && allowed.includes(c.attribution_basis as AttributionBasis))
    .map((c) => ({
      quote_text: String(c.quote_text).trim(),
      speaker_name: c.speaker_name ? String(c.speaker_name).trim() : null,
      attribution_basis: c.attribution_basis as AttributionBasis,
      speaker_title_as_stated: c.speaker_title_as_stated ? String(c.speaker_title_as_stated).trim() : null,
      org_as_stated: c.org_as_stated ? String(c.org_as_stated).trim() : null,
      start_sec: c.start_sec != null ? Number(c.start_sec) : null,
      context_before: c.context_before ? String(c.context_before) : null,
      context_after: c.context_after ? String(c.context_after) : null,
      topic_tags: Array.isArray(c.topic_tags) ? c.topic_tags.map(String).slice(0, 6) : [],
      self_contained: c.self_contained !== false,
      single_claim: c.single_claim !== false,
      pillar_tag: c.pillar_tag && "ABCD".includes(String(c.pillar_tag)) ? String(c.pillar_tag) : null,
    }))
    .slice(0, 5);
}

// Segments -> one flat transcript, with speaker labels, for pass 2 and for the
// verbatim check. Verification runs against THIS string, so it must be exactly
// what the extractor is shown.
export function segmentsToBody(segments: Segment[]): string {
  return segments.map((s) => `${s.speaker_name ?? s.speaker_label}: ${s.text}`).join("\n");
}
