This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

---

## Copy generation

Drafts come out of `lib/generateCopy.ts`. Two rules are enforced in code, not just
asked for in the prompt:

- **One post, never a thread.** Long form inside a single post is fine and often
  better. `formBlock()` in `lib/antiSlop.ts` states it and `scanSlop()` catches it.
- **No em dashes.** `sanitizePrompt()` strips them from the prompt on the way out
  (the data files carried 41 of them, and prompt style is imitated), and
  `autoFixSlop()` strips them from every draft on the way back.

### If drafting is slow or times out

Two settings do almost all the work, both in `lib/generateCopy.ts`:

- **`--effort low`** on the CLI spawn. Without it the model treats drafting as a
  reasoning task and burns tens of thousands of thinking tokens. Measured on one
  curriculum prompt: default 503s / 27,878 thinking tokens, medium 372s / 21,263,
  low 53s / 0, with no quality difference. Override with `COPY_CLI_EFFORT`.
- **A neutral spawn cwd.** The CLI loads whatever project context it finds in the
  working directory. From the repo root that is 110-146k cache-creation tokens
  per call versus ~74k from a temp dir, on a request that needs none of it.

If the CLI still stalls, it falls back to the API backend when `ANTHROPIC_API_KEY`
is set (~15s, ~$0.04), so a bad draw costs a slower draft rather than an error.
The CLI ceiling is 90s when that fallback exists and 240s when it does not.

[ANTI-SLOP.md](./ANTI-SLOP.md) is the house standard: what is banned, why, and
which source each rule came from. `lib/antiSlop.ts` is the machine-readable copy
of it. Edit the two together.

### Grounding: a source we have not read is not draftable

`lib/sourceGrounding.ts`, migration 013. This is the third rule enforced in code,
and the one with the sharpest teeth.

**What went wrong.** The curriculum drafter used to receive a source as title +
URL + summary + `key_facts` and no source text at all, while the analog registry
(`lib/analogs.ts`) handed it a complete TradFi thesis in `parallel` and
`breaksWhere`, and the prompt told it to "CREDIT IT BY NAME IN THE BODY". With
nothing to check against, it welded our thesis onto whichever piece was pinned.
Two different Tokenized episodes each produced three drafts arguing DNS/RTGS
netting mechanics — a subject neither episode raises — attributed to named
guests, one of whom says the opposite on the record. The prompt already said
"never assert a mechanism the source does not support"; that instruction could
not be followed, because there was nothing to evaluate it against.

It was not a handful of rows. At the time the gate went in, **8 of 108 verified
sources had ever been ingested.** The shelf was almost entirely metadata.

**The four gates**, in the order a draft hits them:

1. **No text, no draft.** `analog_sources.text_doc_id` points at the
   `raw_documents` row holding the piece. Null means undraftable — the shelf
   shows a `not ingested` badge and the button is disabled. This applies to the
   blended path too, so an ungrounded row cannot be the one the model picks.
2. **On-topic or refused.** Passages are retrieved by the concept's own `vocab`
   list, not by truncating the head of the document. A source whose text never
   uses any of the concept's vocabulary is refused with a message saying so —
   that is the netting case exactly: a real payments podcast that simply never
   mentions netting.
3. **Claims carry spans.** Every draft returns a `claims` array pairing each
   assertion with the verbatim passage it rests on. Those are matched back
   against the persisted body by `lib/quoteVerify.ts` (the same verbatim gate
   `quote_candidates` passes through). A failed match is a HARD finding; a draft
   still carrying one after its repair round-trip is **dropped**, not surfaced —
   unlike slop findings, which ride out on the option for the operator to judge.
4. **Sponsor reads are stripped first.** The original bad draft cited "Fireblocks
   reported over $100 billion in monthly stablecoin volume" as though a guest had
   said it. It is the mid-roll ad — and it is verbatim in the transcript, so
   span verification alone would have passed it. Ad blocks come out of the body
   before both retrieval and verification.

The prompt also now separates the two bodies of material explicitly: `parallel` /
`breaksWhere` are **ours** to assert, the retrieved passages are the **only**
thing attributable to the source. Collapsing those two was the whole bug.

**Partial transcripts are fine, and deliberately so.** An episode is transcribed
window by window, and a long window sometimes hits Gemini's 280s ceiling. Those
failures no longer discard the windows that succeeded (`transcribeAndPromote`
catches per window and marks the row `partial:`) — the first backfill run lost
seven episodes outright, including both of the ones whose ungrounded drafts
started this, when in most cases one window of three had timed out. Keeping the
rest is safe because the drafter is told the passages it receives are all it has
seen of the piece, and claims verify only against text we actually hold. Less
material yields a narrower post, never a less grounded one.

```bash
npx tsx scripts/check-grounding.ts        # regression check: replays both failures, no DB/network/model
npx tsx scripts/ground-analog-sources.ts  # link sources to text we already hold
npx tsx scripts/ingest-analog-sources.ts  # scrape the web sources we don't (Firecrawl, 1 credit/page)
npx tsx scripts/sweep-channels.ts         # podcasts: transcription lane
```

`check-grounding.ts` asserts in both directions. Fabricated claims must fail, and
the true ones must pass — the first cut of the ad stripper ran a char window
forward from "brought to you by" and ate 2,884 characters of editorial content,
which made two real claims unverifiable. A gate that cries wolf gets switched off,
so over-stripping is treated as a bug of the same severity as under-stripping.

## Operations

### One-off scripts

All scripts run with Node's native TS stripping — no build step:

```bash
node --env-file=.env scripts/<name>.ts
```

| Script | What it does |
|---|---|
| `ingest-articles.ts` | Seeds the `articles` registry from the blog PDFs on disk (`~/Desktop/Product Blogs`, `~/Desktop/Thought Leadership Blogs`). Parses title, standfirst, author, date and canonical URL off page 1 — deterministic, no LLM. Requires `pdftotext` (poppler). |
| `backfill-articles.ts` | Ties existing posts to the article they amplify. Deterministic rungs (blog URL, X-article card, anchor post) are free; `--no-claude` skips the paid content-match rung. |
| `backfill-dimensions.ts` | Recomputes `chains` / `entities` / `products` / `shape` on every post using the same extractor as ingest. |
| `reclassify.ts <template>…` | Re-decides a pillar against the CURRENT taxonomy descriptions. Auto-applies; prints everything that moved. Run after redefining a pillar. |
| `seed-quote-roster.ts` | Seeds `orgs` / `people` / `watch_sources` for quote discovery. Idempotent — operator edits survive a re-run. |
| `sync-docs.ts` | Rebuilds the Dev Doc shelf from `docs.eco.com/llms.txt`: upserts every page, pulls its `.md` body, attributes existing posts to a page, then tags untagged pages with an ICP + postability tier. `--no-tags` to skip the Claude pass, `--force-tags` to re-tag everything except human verdicts. |
| `sync-videos.ts` | Rebuilds the Short-Form Video shelf: YouTube inventory, then the Dropbox manifest, then reconciliation, tagging and post-matching. `--no-tags`, `--no-match`, `--force-tags`. Idempotent — a second run is a no-op. |

### The two registry-first shelves

`articles` groups POSTS by the piece behind them, so a piece nobody has posted never appears. That
is right for re-amplification and wrong for the other two source libraries, where the whole point
is what we have *not* used yet. `doc_pages` and `videos` are therefore read registry-first — every
row shows whether or not a post is attached, and `useCount 0` is the most valuable state, not an
empty one.

**Dev Doc Post → `doc_pages`.** Seeded from `docs.eco.com/llms.txt`, which the docs platform
publishes and keeps current: a section-grouped index of every page with a one-line description
written by the docs team, plus a `.md` twin of each page for the body. New docs pages therefore
appear in the shelf on their own. Attribution is deterministic — `link_resolved_url` against
`doc_pages.url`, after stripping Buffer's `?utm_*` and the `.md` suffix.

Two judgments are stored per page. The **ICP** comes free for `/solutions/<slug>` pages (the URL
names the persona) and from Claude otherwise. The **tier** — hero / supporting / reference — is
what makes the shelf usable: a third of `llms.txt` is endpoint reference nobody will build a post
around, and without a tier those rank beside the persona pages. Reference-tier rows score 0 and
are dropped from the UI entirely.

`docs.eco.com/home` is seeded as a synthetic page, hand-tiered `reference`. It is not in
`llms.txt`, so without it the seven homepage posts would land in the residual "no page" row and
hide the pillar's most expensive habit: homepage posts run a 460 median against 934 for a
deep-linked section.

**Short-Form Video → `videos`.** Two sources merged. YouTube supplies breadth (280 shorts with a
real summary description and a view count); the Dropbox delivery folder supplies the file itself
and the team's own quality verdict, which lives in the folder tree as `Weak (Don't Use)` and is
carried through to `do_not_use` — never recommended, never re-litigated.

Neither the filename nor the title reliably identifies a clip across the two sources (half the
delivery filenames are batch labels like `2026-08-07- Shah 02`), so ingest does a cheap Dice-
coefficient title match and `reconcileDropboxToYouTube()` settles the rest on content. Without
that reconciliation every unmatched file becomes a second row for a clip that already exists and
the headline number — how many clips have never been posted — inflates by a fifth.

Matching a clip to the POST that used it is inference, not lookup: the video is uploaded natively
to X, so exactly one of 58 short-form posts links the channel. A ±14-day publish window narrows
the candidates and Claude picks within it, above a deliberately high confidence bar. Leaving a
post unmatched is cheap; a wrong match marks an unused clip as already-posted and buries it.

#### Dropbox is seeded from a manifest, not synced

The deployed app cannot reach an MCP server, so the Dropbox side of the video shelf comes from
`db/dropbox-shorts-manifest.json` — a listing captured from the Dropbox MCP server and replayed by
`scripts/sync-videos.ts`. The cron refreshes the YouTube side only. Re-capture the manifest when
the delivery folder changes, or add Dropbox app credentials and feed a real listing into the same
`ingestDropboxManifest()`.

### Why articles are a first-class table

`@eco` publishes a piece once and then re-amplifies it for weeks, linking not to
the article but to the **@eco status that carried it**. Before Migration 006 the
shelf read each of those amplifications as a separate article, so a piece already
run five times looked like five fresh options. `posts.article_id` collapses them,
and `article_match` records which rung of the ladder decided it
(`url` → `xurl` → `anchor` → `claude` → `human`). Attribution re-runs on every
sync; human labels are never overwritten.

### Quote discovery

The Quote Card pillar has nothing to re-run — a quote card is used once — so its
expanded section is a discovery pipeline rather than a shelf. See
`db/schema.sql` Migration 007 and `lib/quoteDiscovery.ts`.

Runs are async by lane: `/api/quotes/run` enqueues, `/api/quotes/lane` executes
one lane, `/api/quotes/status` polls. Lanes are split because a Gemini pass over
a 90-minute podcast takes minutes and would blow a serverless duration limit —
and because partial results are genuinely useful (you can work the X lane while
YouTube is still transcribing).

**The verbatim gate is non-negotiable.** Every candidate is string-matched back
against the persisted source before it can reach the queue. A paraphrase scores
`failed` and never appears. A near-match scores `fuzzy`, is flagged
"listen back", and cannot be auto-approved.

### The YouTube lane and the fabricated-transcript problem

The lane works, but getting there surfaced a failure mode worth documenting,
because nothing downstream can catch it.

**A model that cannot read the video will still return a plausible transcript.**
Observed for real: `gemini-2.5-flash` ACCEPTS a YouTube `fileUri` (a malformed
one 400s, so the part is genuinely parsed), contributes ZERO tokens from it, and
invents an interview out of the participant name. Two identical calls fabricated
two different openings, one naming a person unconnected to the video.

Verification (§9) cannot catch this. It checks a quote against the transcript,
and here the transcript is the fabricated artifact — the check is circular. So
the gate lives at ingestion instead, in `transcribeVideo()`:

- `usageMetadata.promptTokenCount` below 2000 → `VideoNotIngestedError`. Even a
  few minutes of low-resolution audio costs thousands of prompt tokens; a couple
  of hundred means only the text prompt was read.
- every segment stamped at `0s` → `VideoNotIngestedError`. That is the shape a
  fabricated transcript takes, and it also means no deep link could land.

Either one aborts the lane and marks it **failed** — deliberately not "complete
with 0 results", which would read as a quiet day.

**Capacity, not permissions.** Video-capable models return `503 UNAVAILABLE`
("experiencing high demand") readily — on a 12-minute clip as often as a
72-minute one. So `gemini()` retries transient statuses (429/500/502/503/504)
with backoff and then falls through `GEMINI_VIDEO_FALLBACKS`. Without that a
single spike fails the whole lane; with it, transcription succeeds.

**Timestamps drift long.** On a 724-second clip the model returned segments
stamped out to 1118s — 54% past the end, which would send every deep link past
the end of the video. `transcribeVideo()` rescales proportionally when the
overrun is systematic, then clamps to the real duration.

**Coverage is uneven by design.****Coverage is uneven by design.** The official X API's recent search reaches back
7 days only and full-archive is Enterprise-only, so X is the shallow-but-recent
lane (historical depth comes from paginating roster timelines with a persisted
`since_id`). YouTube and published reports carry the historical recall. The UI
shows per-lane status rather than one undifferentiated list so this is visible.

## The channel lane (Lane 1 podcast sourcing)

Three YouTube channels feed the analog curriculum: **Money Code**
(`@moneycodepod`), **Tokenized** (`@TokenizedPodcast`) and **What's Next with
Philip Meissner** (`@WhatsNextwithPhilipMeissner`). See Migration 012,
`lib/channels.ts`, `lib/channelSweep.ts`, `lib/channelSources.ts` and
`lib/channelTranscribe.ts`.

### Why it is a separate lane and not three new hubs

`lib/analogSweep.ts` is **concept-first**: `pickConceptsToSweep()` rotates four
concepts and, for each, builds two queries and maps that concept's institutional
hubs. You cannot cheaply ask "what did Tokenized say about nostro accounts" — you
enumerate what the channel published and then decide which concept it serves. The
lane is inverted, so it gets its own ledger. (It is also why these are not
`AnalogDef.hubs` entries: `SKIP_HOST` excludes `youtube.com` deliberately, and
scraping a watch page returns markup.)

### The cost ladder

Only the last rung costs real money; the first three exist to reach it rarely.

| Rung | Cost | What it does |
|---|---|---|
| list | 3 YouTube quota units per channel | Uploads playlist, not `search.list` (which is 100) |
| triage | one batched Claude call | title + description + chapters → concepts, windows, description facts |
| describe | free | a `current` source row with `facts_source='description'` |
| transcribe | Gemini | only the flagged chapter windows, or a whole clip |

Measured on the first live runs: 40 videos triaged in 6 Claude calls (~38k in /
~8k out, 9 quota units, 0 Firecrawl credits); 26 description-tier source rows
across 9 episodes with no transcription at all; and **141 minutes of flagged
windows against 584 minutes of whole episodes**.

### Podcasts can never be canonical

Enforced in code — `NEVER_CANONICAL` in `lib/analogSweep.ts` forces
`kind='podcast'` to `tier='current'`, whatever a model decides. Money Code is
"Presented by Stablecon; Powered by BVNK" and Tokenized is co-hosted by Visa's
head of crypto. Both are excellent on what happened this month and neither is an
authority on how CHIPS settles, and `canonical` means "the institution explaining
its own mechanism, still true in five years". The summary handed to the drafter
also states the publisher's commercial position, so a practitioner's account of
their own operations cannot read as a measurement.

This is the layer the institutional lane structurally cannot supply. Measured:
`canonicalOnly` fell from 10 concepts to 7, concepts with a current source rose
from 10 to 13, and `correspondent_banking`, `least_cost_routing` and
`nostro_vostro` now have **no** current source except a podcast.

### Three things the metadata taught us, all measured

**Triage cannot be the vocab matcher.** `detectAnalog()` over 36 recent videos
matched **3** on titles. The vocabulary is tradfi ("nostro", "prefunding") and
these channels speak stablecoin-native, so "The Funding Bottleneck Slowing
Stablecoin Payments" — a textbook `nostro_vostro` episode — matched nothing.
Adding descriptions reached 14/36 but introduced a worse failure (below). The
matcher is still run and printed by `scripts/sweep-channels.ts` as a cross-check,
so the measurement stays visible; it never gates.

**Every long-form episode ships 10-17 timestamped chapters.** A human-written
topic index, free, and the reason windowed transcription is possible. Parsed
deterministically by `parseChapters()`, which rejects prose timestamps (a guest
saying "see 12:30") because treating one as a chapter would send a paid window at
random.

**Clips inherit their parent episode's entire description, byte-identical.** Five
Money Code clips and the episode they were cut from all carry the same 2,822
characters. So the parent key is exact, one triage covers a whole clip family —
and description-derived facts belong to the **episode only**. Storing "$3B over
the last 12 months" on all six would put one claim behind six citations and
inflate every count on a shelf whose only job is honest coverage. A clip
contributes nothing until it is transcribed.

### One transcript, two consumers

Transcripts land in `raw_documents`, where the quote pipeline already reads, so a
single Gemini pass produces both curriculum facts (`analog_sources`,
`facts_source='transcript'`) and quote candidates — the latter through
`ingestDocQuotes()`, which was lifted out of `runLane()` precisely so the verbatim
gate has one implementation. The three channels are also in `WATCH_SEED`, so
whichever lane reaches a video first pays for it.

This also fixed a pre-existing cost bug: the YouTube quote lane transcribed
*before* checking `raw_documents` and deduped only at INSERT, so with the 365-day
default lookback the same episodes were re-transcribed every run while newer ones
were crowded out by the 12-video cap.

### The fabricated-transcript gate on a windowed call

`transcribeVideo()`'s `promptTokenCount` floor still applies, scaled to the window
(`min(2000, max(400, windowSec * 8))`) rather than left flat — low-resolution
video runs on the order of a thousand prompt tokens a minute, so a two-minute
window is still thousands, but a deliberately tiny window must not make the gate
impossible to pass and turn a real refusal into a false `VideoNotIngestedError`.
**Gemini uses either clock on a windowed call, so the clock is detected rather
than assumed.** Observed on a 2812-second episode windowed to 636-829s: it
returned timestamps in WHOLE-VIDEO time out to ~2800. The whole-video rescale
then compressed them proportionally into 0..193 and the offset shift added 636,
producing segments 0.69 and 0.1 seconds long that each carried a full sentence.
Those land INSIDE the window, so no range check catches them, and a deep link
built from one points at 646s for a quote spoken near 1900s.

So `transcribeVideo()` branches on which frame the values fall in — clip-relative
(clamp, then shift), already whole-video (clamp into the window, no shift), or
neither. Proportional rescale still applies to whole-video passes, where a
systematic overrun is what it was written for.

**Frame detection alone was not enough.** With every segment correctly inside its
window, one episode still returned a NEGATIVE duration and a median of 153 words
per second while another was entirely plausible at 3.7. A per-call frame guess
cannot rescue output whose segments disagree with each other, so the timing has
its own gate on the one property checkable without the audio: speech rate.
Natural speech is 2-3 words a second; if more than a third of a window's segments
fall outside 0.4-8 wps, or run negative, or exceed 240s, the whole window's timing
is discarded and every segment anchors to the window start.

**Deep links were reaching `&t=0` regardless, and that was a latent bug in the
quote pipeline.** `segmentsToBody()` renders a transcript as "Speaker: text" lines
with no timestamps in them, and Pass 2 extracts quotes from that text — so
`RawCandidate.start_sec` had nothing to derive from and came back 0 on every
YouTube quote the app has ever produced. All the rescaling and clamping in
`transcribeVideo()` existed to make the link land correctly and was never reaching
it. `segmentStartForQuote()` in `lib/quoteVerify.ts` recovers it with no prompt
change and no extra model call: the verbatim gate has already proved the quote is
in the body, so the segment carrying it is found the same way and its `start_sec`
used. It returns null rather than guessing, which leaves the plain video URL.

**So a windowed pass gives chapter-level link precision, not moment-level.** That
is the honest description of the feature. The window was chosen because its
published chapter label named the mechanism, so its start is where a human
skimming the chapter list would land anyway — and this codebase's rule is that a
null is free while a wrong deep link is worse than none. The TEXT is unaffected:
facts and quotes are extracted from it and the verbatim gate checks against the
same text, so correctness never depended on the timestamps.

### Operations

```bash
node --env-file=.env scripts/sweep-channels.ts --dry-run     # writes nothing
node --env-file=.env scripts/sweep-channels.ts               # ledger only
node --env-file=.env scripts/sweep-channels.ts --sources     # + description tier
node --env-file=.env scripts/sweep-channels.ts --transcribe --limit 3
```

`--transcribe` is the only flag that spends real money, so it is never implied.
Two crons, on separate clocks for the same reason `/api/sweep` is split from
`/api/sync` — a step that always gets cut is a step that does not exist:

| Route | Schedule | Cost |
|---|---|---|
| `/api/channels` | 08:00 | list + triage + description tier |
| `/api/channels/transcribe` | 08:30 | Gemini, 4 videos a run |

A fabricated-transcript abort returns **500**, not a thin 200 — it must not read
as a quiet day.
