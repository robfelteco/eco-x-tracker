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
