import Anthropic from "@anthropic-ai/sdk";
import { sql } from "./db.ts";

// Which clip did a short-form post actually use?
//
// This has to be inferred rather than read. The video is uploaded natively to X,
// so the post carries no YouTube link — exactly ONE of 58 short-form posts links
// the channel at all. What we do have is a strong empirical pairing: a clip goes
// up on YouTube within a couple of days of the X post, and the two describe the
// same argument in different words. Spot-checked against the corpus:
//
//   X "The smartest thing you can do to solver design? Make it dumb."
//     <-> YT "Making Crypto Solvers Dumb Again"
//   X "...tools and policies around AI agents so they're safe to transact onchain"
//     <-> YT "AI Agent Safety for Onchain Payments"
//   X "...fastest way to move money onchain usually the one where you hand over custody?"
//     <-> YT "Move Stablecoins Fast, No Custody Required"
//
// Date proximity alone is far too loose — a +/-3 day window already returns three
// to six candidates. So the date window is a CANDIDATE FILTER and Claude picks
// within it, the same shape as lib/articleMatchClaude.ts.
//
// Two rules keep this honest:
//   1. It can only choose from the candidate list. It cannot invent a clip.
//   2. Below threshold the post stays unmatched, and unmatched is a fine answer.
//      A wrong match does real damage here — it would mark an unused clip as
//      "already posted" and bury it, which is the one thing this shelf exists to
//      prevent. So the threshold is deliberately high and null is cheap.

const MODEL = "claude-sonnet-4-6";

// Days either side of the post to consider. Wide enough to catch a clip
// uploaded the week after it ran on X, narrow enough to keep the candidate
// list short and the decision easy.
export const MATCH_WINDOW_DAYS = 14;

export const VIDEO_MATCH_THRESHOLD = 0.75;

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

// Same tolerance for a single-object reply.
function parseObject<T>(raw: string): T {
  const txt = stripFences(raw);
  try {
    return JSON.parse(txt) as T;
  } catch {
    const start = txt.indexOf("{");
    const end = txt.indexOf("}", start + 1);
    if (start === -1 || end === -1) return {} as T;
    try {
      return JSON.parse(txt.slice(start, end + 1)) as T;
    } catch {
      return {} as T;
    }
  }
}

// Occasionally a reply opens with a line of reasoning before the array. Rather
// than lose a whole batch to a JSON.parse throw, slice out the first bracketed
// array and parse that.
function parseArray<T>(raw: string): T[] {
  const txt = stripFences(raw);
  try {
    return JSON.parse(txt) as T[];
  } catch {
    const start = txt.indexOf("[");
    const end = txt.lastIndexOf("]");
    if (start === -1 || end <= start) return [];
    try {
      return JSON.parse(txt.slice(start, end + 1)) as T[];
    } catch {
      return [];
    }
  }
}

export interface VideoMatchResult {
  considered: number;
  matched: number;
  unmatched: number;
  noCandidates: number;
  errors: string[];
}

const SYSTEM = `
You decide whether an @eco X post used a specific short video clip.

The post's copy was written ABOUT the clip and rarely repeats its title — it usually opens with a
question the clip answers, then names the speaker. Your job is to tell whether the post and one of
the candidate clips are about the SAME argument.

Strong evidence: the post's question is the clip's thesis; both name the same speaker; both turn on
the same specific mechanism, number or claim.
Weak evidence: both are about stablecoins generally; both mention Eco; the dates are close. These
are NOT enough on their own — every candidate shares them.

If no candidate is clearly the same clip, return null. Null is the correct and expected answer for
many posts: the clip may never have been uploaded to the channel. A wrong match is far more costly
than a miss, because it marks an unused clip as already-posted and hides it.

Reply with ONLY: {"video_id": <number|null>, "confidence": <0..1>, "why": "<12 words max>"}
No prose, no code fences.
`.trim();

// Match every short-form post that has no clip yet. Human matches are never
// revisited, same precedence rule as article and docs attribution.
export async function matchVideosToPosts(opts: { limit?: number } = {}): Promise<VideoMatchResult> {
  const res: VideoMatchResult = {
    considered: 0,
    matched: 0,
    unmatched: 0,
    noCandidates: 0,
    errors: [],
  };

  const posts = await sql<{ id: string; text: string; createdAt: string }>`
    SELECT id, text, created_at AS "createdAt"
    FROM posts
    WHERE template = 'short_form_video_eco'
      AND is_reply = false
      AND video_id IS NULL
      AND COALESCE(video_match, '') <> 'human'
    ORDER BY created_at DESC
    LIMIT ${opts.limit ?? 500}`;

  for (const post of posts) {
    res.considered++;

    // Candidates: clips published within the window that no post has claimed.
    // Excluding already-claimed clips matters — without it the model will
    // happily assign one popular clip to three different posts.
    const candidates = await sql<{
      id: number;
      title: string;
      description: string | null;
      ytPublishedOn: string | null;
      durationSec: number | null;
    }>`
      SELECT v.id, v.title, v.description,
             to_char(v.yt_published_on, 'YYYY-MM-DD') AS "ytPublishedOn",
             v.duration_sec AS "durationSec"
      FROM videos v
      WHERE v.active = true
        AND v.yt_published_on IS NOT NULL
        AND v.yt_published_on BETWEEN
              (${post.createdAt}::timestamptz - ${`${MATCH_WINDOW_DAYS} days`}::interval)::date
          AND (${post.createdAt}::timestamptz + ${`${MATCH_WINDOW_DAYS} days`}::interval)::date
        AND NOT EXISTS (SELECT 1 FROM posts p2 WHERE p2.video_id = v.id)
      ORDER BY v.yt_published_on`;

    if (!candidates.length) {
      res.noCandidates++;
      continue;
    }

    try {
      const msg = await client().messages.create({
        model: MODEL,
        max_tokens: 300,
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content: JSON.stringify(
              {
                post: { posted_on: post.createdAt, text: post.text.slice(0, 900) },
                candidate_clips: candidates.map((c) => ({
                  video_id: Number(c.id),
                  title: c.title,
                  description: (c.description ?? "").slice(0, 500),
                  published_on: c.ytPublishedOn,
                  duration_sec: c.durationSec,
                })),
              },
              null,
              1,
            ),
          },
        ],
      });
      const raw = msg.content.find((c) => c.type === "text");
      const parsed = parseObject<{
        video_id?: number | null;
        confidence?: number;
      }>(raw && "text" in raw ? raw.text : "{}");

      const vid = parsed.video_id == null ? null : Number(parsed.video_id);
      const conf = Number(parsed.confidence ?? 0);
      const valid = vid != null && candidates.some((c) => Number(c.id) === vid);

      if (valid && conf >= VIDEO_MATCH_THRESHOLD) {
        await sql`
          UPDATE posts
          SET video_id = ${vid}, video_match = 'claude', video_confidence = ${conf}, updated_at = now()
          WHERE id = ${post.id}`;
        res.matched++;
      } else {
        res.unmatched++;
      }
    } catch (e) {
      res.errors.push(`${post.id}: ${e instanceof Error ? e.message : String(e)}`);
      res.unmatched++;
    }
  }

  return res;
}

// ---------------------------------------------------------------------------
// Dropbox file -> YouTube clip reconciliation
// ---------------------------------------------------------------------------

// The delivery folder is literally named "All Published YouTube Shorts Vids", so
// most files in it ARE a clip already on the channel — but the filenames cannot
// prove it. Roughly half are batch labels ("2026-08-07- Shah 02") with no
// subject in them at all, and the descriptive half are the editor's working
// name rather than the published title ("22-Eco is not A Bridge, it's Interop
// Protocol" vs whatever SEO title the upload got).
//
// Left unreconciled, each of those files becomes a SECOND row for a clip that
// already exists, and the shelf's headline number — how many clips have never
// been posted — is inflated by a fifth. So filename matching gets the easy ones
// and this reconciles the rest on content.
//
// The YouTube catalogue is small enough (a few hundred titles) to hand over
// whole, so the model picks from a closed list and cannot invent a clip. As
// everywhere else in the attribution stack, null is an acceptable answer: a file
// genuinely may never have been uploaded.

const RECONCILE_BATCH = 8;

const RECONCILE_SYSTEM = `
You are reconciling video FILES from a team's delivery folder against a catalogue of clips
already published to a YouTube channel. Both describe the same library; the filenames are the
editor's working names and the catalogue entries are the published titles and descriptions.

For each file, decide which catalogue clip it is — or none.

Some filenames are pure batch labels ("2026-08-07- Shah 02") with no subject. For those, use the
transcript excerpt if one is given: match it against what each clip's title and description say
the clip argues. A transcript is strong evidence when its central claim is the clip's thesis.

Some filenames are descriptive but worded differently from the published title
("22-Eco is not A Bridge, it's Interop Protocol"). Match on subject, not wording.

Return null when no catalogue clip is clearly the same video. Null is correct and common — a file
may simply never have been uploaded. A wrong match merges two different clips into one row and
hides one of them, which is worse than leaving a file unlinked.

Reply with ONLY a JSON array, one object per file, in input order:
[{"file_index": <number>, "video_id": <number|null>, "confidence": <0..1>}]
No prose, no code fences.
`.trim();

export interface ReconcileResult {
  considered: number;
  merged: number;
  leftStandalone: number;
  errors: string[];
}

export async function reconcileDropboxToYouTube(): Promise<ReconcileResult> {
  const res: ReconcileResult = { considered: 0, merged: 0, leftStandalone: 0, errors: [] };

  const orphans = await sql<{
    id: number;
    title: string;
    transcript: string | null;
    dropboxFolder: string | null;
  }>`
    SELECT id, title, transcript, dropbox_folder AS "dropboxFolder"
    FROM videos
    WHERE yt_video_id IS NULL AND dropbox_file_id IS NOT NULL AND active = true
    ORDER BY id`;
  if (!orphans.length) return res;

  const catalogue = await sql<{
    id: number;
    title: string;
    description: string | null;
    ytPublishedOn: string | null;
  }>`
    SELECT id, title, description, to_char(yt_published_on, 'YYYY-MM-DD') AS "ytPublishedOn"
    FROM videos
    WHERE yt_video_id IS NOT NULL AND active = true
      -- A clip that already carries a file is not a candidate. Without this a
      -- later run can hand the same YouTube row to a second file, overwriting
      -- the first file id and orphaning that file — which the next sync then
      -- re-inserts as a fresh duplicate, forever.
      AND dropbox_file_id IS NULL
    ORDER BY yt_published_on DESC NULLS LAST`;

  const cat = catalogue.map((c) => ({
    video_id: Number(c.id),
    title: c.title,
    summary: (c.description ?? "").slice(0, 220),
    published_on: c.ytPublishedOn,
  }));
  const catIds = new Set(cat.map((c) => c.video_id));

  // A clip can only absorb one file. Without this the model will hand the same
  // popular clip to several near-identical delivery variants.
  const claimed = new Set<number>();

  for (let i = 0; i < orphans.length; i += RECONCILE_BATCH) {
    const batch = orphans.slice(i, i + RECONCILE_BATCH);
    res.considered += batch.length;
    try {
      const msg = await client().messages.create({
        model: MODEL,
        max_tokens: 900,
        system: RECONCILE_SYSTEM,
        messages: [
          {
            role: "user",
            content: JSON.stringify(
              {
                files: batch.map((o, idx) => ({
                  file_index: idx,
                  filename: o.title,
                  delivery_folder: o.dropboxFolder,
                  transcript_excerpt: o.transcript ? o.transcript.slice(0, 1200) : null,
                })),
                catalogue: cat.filter((c) => !claimed.has(c.video_id)),
              },
              null,
              1,
            ),
          },
        ],
      });
      const raw = msg.content.find((c) => c.type === "text");
      const parsed = parseArray<{
        file_index?: number;
        video_id?: number | null;
        confidence?: number;
      }>(raw && "text" in raw ? raw.text : "[]");

      for (const v of parsed) {
        const orphan = batch[Number(v.file_index)];
        const vid = v.video_id == null ? null : Number(v.video_id);
        if (!orphan) continue;
        if (vid == null || !catIds.has(vid) || claimed.has(vid)) {
          res.leftStandalone++;
          continue;
        }
        if (Number(v.confidence ?? 0) < VIDEO_MATCH_THRESHOLD) {
          res.leftStandalone++;
          continue;
        }
        // Fold the file (and its transcript, and any do-not-use verdict) onto
        // the YouTube row.
        //
        // DELETE FIRST, then update. Doing it the other way round — UPDATE ...
        // FROM the orphan, then delete — violates the unique index on
        // dropbox_file_id, because at the moment the target takes the file id
        // the orphan is still holding it.
        const [src] = await sql<{
          dropboxFileId: string;
          dropboxPath: string | null;
          dropboxFolder: string | null;
          dropboxBytes: number | null;
          transcript: string | null;
          transcriptSource: string | null;
          doNotUse: boolean;
        }>`
          DELETE FROM videos WHERE id = ${orphan.id}
          RETURNING dropbox_file_id AS "dropboxFileId", dropbox_path AS "dropboxPath",
                    dropbox_folder AS "dropboxFolder", dropbox_bytes AS "dropboxBytes",
                    transcript, transcript_source AS "transcriptSource",
                    do_not_use AS "doNotUse"`;
        if (!src) {
          res.leftStandalone++;
          continue;
        }
        await sql`
          UPDATE videos SET
            dropbox_file_id = ${src.dropboxFileId},
            dropbox_path = ${src.dropboxPath},
            dropbox_folder = ${src.dropboxFolder},
            dropbox_bytes = ${src.dropboxBytes},
            transcript = COALESCE(${src.transcript}::text, transcript),
            transcript_source = COALESCE(${src.transcriptSource}::text, transcript_source),
            do_not_use = do_not_use OR ${src.doNotUse},
            updated_at = now()
          WHERE id = ${vid}`;
        claimed.add(vid);
        res.merged++;
      }
    } catch (e) {
      res.errors.push(`batch ${i}: ${e instanceof Error ? e.message : String(e)}`);
      res.leftStandalone += batch.length;
    }
  }

  return res;
}
