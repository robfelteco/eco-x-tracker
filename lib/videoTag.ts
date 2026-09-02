import Anthropic from "@anthropic-ai/sdk";
import { sql } from "./db.ts";
import { icpPromptBlock, ICP_IDS } from "./icp.ts";
import { SERIES_DEFS, SPEAKER_LABELS } from "./videos.ts";
import { ECO_ONE_LINER } from "./positioning.ts";

// Tagging pass for the video shelf: series, speaker, ICP, topic, and the line
// worth building a post around.
//
// Why tag at all rather than just listing 280 clips by date: the shelf is only
// useful if it can be entered from a question the operator actually has —
// "what have we got for the treasury audience", "we have leaned on Head of
// Product clips for a month, what else is there". A flat reverse-chronological
// list of 280 filenames is the same problem as the flat docs list.
//
// Runs once per clip. A human verdict (tag_source 'human') is never overwritten.

const MODEL = "claude-sonnet-4-6";
const BATCH = 10;

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
    _client = new Anthropic();
  }
  return _client;
}

function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

const SYSTEM = `
You are cataloguing short-form video clips produced by Eco, so that a social operator can find
the right clip to post on X.

${ECO_ONE_LINER}

The people who appear on camera are Ryne Saxe (CEO, @rynesaxe), a Head of Product (@strao_), and
Shah, who fronts an educational explainer series.

For each clip you get a title, a description (often a real summary of the clip's argument), a
duration, and sometimes a transcript. Return five judgments per clip.

1. series — the format. Options:
${SERIES_DEFS.map((s) => `   - ${s.id}: ${s.label} — ${s.hint}`).join("\n")}

2. speaker — who is talking, if identifiable. Options: ${Object.keys(SPEAKER_LABELS).join(", ")}.
   Use "none" for a produced piece with no on-camera speaker. Use "third_party" for someone
   outside Eco. Do NOT guess a named Eco person unless the text actually names or implies them.

3. icp — which single audience the clip is most useful for. Options:
${icpPromptBlock()}
   "builders" is the honest default for general technical explainers.

4. topic — 2 to 5 words naming the subject, in plain language. Used to group the shelf, so prefer
   a label that would apply to several clips ("solver economics", "agentic payments",
   "cross-chain UX") over one that is unique to this clip.

5. hook — ONE sentence, max 22 words: the specific claim or moment in this clip worth building a
   post around. Draw it from the actual content. No marketing language. If the material is too
   thin to tell, write "Thin metadata — watch before posting."

Reply with ONLY a JSON array, one object per clip, in input order:
[{"id": <number>, "series": "<id>", "speaker": "<id>", "icp": "<id>", "topic": "<label>", "hook": "<sentence>"}]
No prose, no code fences.
`.trim();

export interface VideoTagResult {
  tagged: number;
  skipped: number;
  bySeries: Record<string, number>;
  errors: string[];
}

export async function tagVideos(opts: { force?: boolean; limit?: number } = {}): Promise<VideoTagResult> {
  const res: VideoTagResult = { tagged: 0, skipped: 0, bySeries: {}, errors: [] };
  const limit = opts.limit ?? 1000;

  const clips = await sql<{
    id: number;
    title: string;
    description: string | null;
    transcript: string | null;
    durationSec: number | null;
  }>`
    SELECT id, title, description, transcript, duration_sec AS "durationSec"
    FROM videos
    WHERE active = true
      AND do_not_use = false
      AND COALESCE(tag_source, '') <> 'human'
      AND (${!!opts.force} OR series IS NULL)
    ORDER BY yt_published_on DESC NULLS LAST, id
    LIMIT ${limit}`;

  const validSeries = new Set(SERIES_DEFS.map((s) => s.id));
  const validSpeakers = new Set(Object.keys(SPEAKER_LABELS));

  for (let i = 0; i < clips.length; i += BATCH) {
    const batch = clips.slice(i, i + BATCH);
    const payload = batch.map((c) => ({
      id: Number(c.id),
      title: c.title,
      description: c.description,
      duration_sec: c.durationSec,
      transcript_excerpt: c.transcript ? c.transcript.slice(0, 1500) : null,
    }));

    try {
      const msg = await client().messages.create({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM,
        messages: [{ role: "user", content: JSON.stringify(payload, null, 1) }],
      });
      const raw = msg.content.find((c) => c.type === "text");
      const parsed: Record<string, string>[] = JSON.parse(
        stripFences(raw && "text" in raw ? raw.text : "[]"),
      );

      let applied = 0;
      for (const v of parsed) {
        // bigint ids arrive from the driver as strings — coerce both sides.
        const clip = batch.find((c) => Number(c.id) === Number(v.id));
        if (!clip) continue;
        applied++;
        const series = validSeries.has(v.series) ? v.series : "product_explainer";
        const speaker = validSpeakers.has(v.speaker) ? v.speaker : null;
        const icp = ICP_IDS.includes(v.icp) ? v.icp : "builders";
        await sql`
          UPDATE videos
          SET series = ${series}, speaker = ${speaker}, icp = ${icp},
              topic = ${(v.topic ?? "").slice(0, 80)},
              hook = ${(v.hook ?? "").slice(0, 400)},
              tagged_at = now(), tag_source = 'claude', updated_at = now()
          WHERE id = ${clip.id}`;
        res.tagged++;
        res.bySeries[series] = (res.bySeries[series] ?? 0) + 1;
      }
      res.skipped += batch.length - applied;
    } catch (e) {
      res.errors.push(`batch ${i}: ${e instanceof Error ? e.message : String(e)}`);
      res.skipped += batch.length;
    }
  }

  return res;
}
