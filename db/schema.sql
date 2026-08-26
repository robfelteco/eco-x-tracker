-- Eco X Post Template Tracker — Postgres schema (Neon)
--
-- Design notes vs. Jay's eco-x-studio (which uses Redis + overwrites metrics):
--   * Posts are DURABLE rows, not a live-timeline cache.
--   * Metrics are TIMESTAMPED SNAPSHOTS (one row per post per fetch), never
--     overwritten — the X API only ever returns *current* numbers, so our
--     snapshots ARE the growth history. Deduped to one snapshot per post/day.
--   * "Last posted" per template is DERIVED at query time (MAX(created_at)
--     GROUP BY template), never stored as a mutable column.
--   * Classification (template + confidence + source) is new in our app.
--
-- Apply with: psql "$DATABASE_URL" -f db/schema.sql   (idempotent)

-- ---------------------------------------------------------------------------
-- Content-template taxonomy. Kept as an enum so a bad label can't be written,
-- but 'other' is a real bucket that routes to the review queue. Adding a new
-- template later = one ALTER TYPE ... ADD VALUE (see lib/taxonomy.ts, the
-- single source of truth the app codes against).
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE content_template AS ENUM (
    'data_motion_visual',
    'integration_announcement',
    'quote_card',
    'product_post',
    'thought_leadership',
    'dev_doc_post',
    'broad_educational',
    'short_form_video_eco',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Who/what assigned the current template. Human always wins and is never
-- overwritten by a re-classification run.
DO $$ BEGIN
  CREATE TYPE classification_source AS ENUM ('rule', 'claude', 'human');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- posts — one row per @eco tweet we've ingested. Post ID (string) is the PK.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS posts (
  id                text PRIMARY KEY,               -- tweet id (string; JS-unsafe as number)
  url               text NOT NULL,
  created_at        timestamptz NOT NULL,           -- tweet publish time (X created_at)
  text              text NOT NULL,                  -- full text (note_tweet.text when long-form)

  -- Entities (expanded).
  urls              jsonb NOT NULL DEFAULT '[]',    -- [{url, expanded_url, domain}]
  domains           text[] NOT NULL DEFAULT '{}',   -- flattened outbound domains, for cheap rule matching
  mentions          text[] NOT NULL DEFAULT '{}',   -- @handles (lowercased)
  hashtags          text[] NOT NULL DEFAULT '{}',

  -- Media.
  media_type        text NOT NULL DEFAULT 'text',   -- video | photo | animated_gif | link-card | text
  media_urls        jsonb NOT NULL DEFAULT '[]',    -- image/video urls
  preview_image_url text,                           -- video thumbnail (for multimodal classify)

  -- Post shape. We track only MAIN posts: reposts and replies (self-replies AND
  -- replies to others) are excluded at ingestion. The flags are retained on any
  -- legacy rows and every read query filters is_reply = false as a backstop.
  is_reply          boolean NOT NULL DEFAULT false,
  is_self_reply     boolean NOT NULL DEFAULT false, -- reply where author == @eco
  is_quote          boolean NOT NULL DEFAULT false,

  -- Manual flag; set in the UI, cannot come from the API. Every per-template
  -- average must be filterable by amplified vs organic or the baseline is junk.
  amplified         boolean NOT NULL DEFAULT false,

  -- Classification (current, denormalized onto the post for fast dashboard reads).
  template          content_template,               -- null until classified
  confidence        real,                           -- 0..1
  reasoning         text,                           -- one sentence from the classifier
  class_source      classification_source,          -- rule | claude | human
  classified_at     timestamptz,
  -- dev_doc_post optional sub-tag (store now, classify later / manually).
  sub_tag           text,                           -- 'soft_sell' | 'hard_sell' | null

  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS posts_template_idx     ON posts (template);
CREATE INDEX IF NOT EXISTS posts_created_at_idx   ON posts (created_at DESC);
CREATE INDEX IF NOT EXISTS posts_confidence_idx   ON posts (confidence);
CREATE INDEX IF NOT EXISTS posts_amplified_idx    ON posts (amplified);

-- ---------------------------------------------------------------------------
-- metric_snapshots — append-only. One row per post per fetch; deduped to one
-- per post per UTC day (see the unique index). This table IS the growth curve.
-- non_public_* are only available for posts <~30d old via OAuth user context;
-- null means "was unavailable at fetch time", recorded rather than errored.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS metric_snapshots (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id           text NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  fetched_at        timestamptz NOT NULL DEFAULT now(),
  fetched_on        date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date, -- dedup key

  impressions       integer,
  likes             integer,
  replies           integer,
  retweets          integer,
  quotes            integer,
  bookmarks         integer,

  -- non_public_metrics (user-context only, <30d).
  url_link_clicks     integer,   -- null = unavailable at fetch
  user_profile_clicks integer,
  non_public_available boolean NOT NULL DEFAULT false
);

-- One snapshot per post per day. ON CONFLICT DO UPDATE lets a later same-day
-- run refresh the numbers without creating a second row for that day.
CREATE UNIQUE INDEX IF NOT EXISTS metric_snapshots_post_day_uidx
  ON metric_snapshots (post_id, fetched_on);
CREATE INDEX IF NOT EXISTS metric_snapshots_post_idx ON metric_snapshots (post_id, fetched_at DESC);

-- ---------------------------------------------------------------------------
-- labels — ground-truth human corrections. Every confirmed/corrected review
-- becomes a row here and feeds the few-shot pool for future Claude calls.
-- Separate from posts.template so the training signal survives even if a post
-- is later re-ingested; posts.template mirrors the latest human label.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS labels (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id       text NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  template      content_template NOT NULL,
  labeled_by    text NOT NULL,          -- operator email
  labeled_at    timestamptz NOT NULL DEFAULT now(),
  prev_template content_template,       -- what the classifier had guessed (for audit)
  prev_source   classification_source
);
CREATE INDEX IF NOT EXISTS labels_post_idx     ON labels (post_id);
CREATE INDEX IF NOT EXISTS labels_template_idx ON labels (template);

-- ---------------------------------------------------------------------------
-- sync_runs — one row per sync (cron or manual). Surfaced in the UI so a silent
-- failure is visible (mirrors Jay's cronLog, but as durable rows we can trend).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_runs (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  trigger        text NOT NULL,          -- 'cron' | 'manual'
  ok             boolean,
  posts_added    integer NOT NULL DEFAULT 0,
  posts_updated  integer NOT NULL DEFAULT 0,
  snapshots      integer NOT NULL DEFAULT 0,
  classified     integer NOT NULL DEFAULT 0,
  x_reads        integer NOT NULL DEFAULT 0,
  est_cost_usd   numeric(10,4) NOT NULL DEFAULT 0,
  summary        text,                   -- one human sentence
  errors         jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS sync_runs_started_idx ON sync_runs (started_at DESC);

-- ---------------------------------------------------------------------------
-- Migration 002 — link-preview enrichment (idempotent ADD COLUMN IF NOT EXISTS).
-- Many posts carry their substance behind an outbound link — external articles
-- and especially X's native long-form "Articles" (a t.co that opens an article
-- whose body isn't in the tweet text). We resolve the link and scrape its OG
-- card (title/description/image) so (a) the classifier can READ article posts
-- instead of dumping them in review, and (b) every link/article post gets a
-- thumbnail. See lib/enrich.ts. Populated best-effort during sync; null = not
-- yet enriched or no usable card.
-- ---------------------------------------------------------------------------
ALTER TABLE posts ADD COLUMN IF NOT EXISTS link_resolved_url text; -- t.co → final URL
ALTER TABLE posts ADD COLUMN IF NOT EXISTS link_title        text;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS link_description  text;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS link_image_url    text; -- OG/twitter card image
ALTER TABLE posts ADD COLUMN IF NOT EXISTS enriched_at       timestamptz;

-- ---------------------------------------------------------------------------
-- Migration 003 — quoted-tweet thumbnail. For a QUOTE post the visual the reader
-- sees is the quoted tweet's own image (native photo/video poster, or the cover
-- of a quoted X native Article). The quoting post rarely repeats it, so we pull
-- it from the referenced-tweet expansion at ingest (see lib/twitter.ts) and use
-- it as the row thumbnail. null = not a quote, or the quote has no visual.
-- ---------------------------------------------------------------------------
ALTER TABLE posts ADD COLUMN IF NOT EXISTS quoted_image_url  text;

-- ---------------------------------------------------------------------------
-- Migration 004 — chain / entity sub-dimensions. A post's template (its content
-- pillar) is only one axis; the Insights tab also needs to know WHICH chain and
-- WHICH company/partner a post highlights, so it can answer "you just did a
-- Solana data-motion visual — the next best chain is Arbitrum." Extracted
-- deterministically from @-mentions + domains + distinctive text tokens at
-- ingest (see lib/dimensions.ts). Empty array = none detected. Multi-valued: a
-- post can highlight several chains/partners and counts toward each.
-- ---------------------------------------------------------------------------
ALTER TABLE posts ADD COLUMN IF NOT EXISTS chains   text[] NOT NULL DEFAULT '{}';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS entities text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS posts_chains_idx   ON posts USING gin (chains);
CREATE INDEX IF NOT EXISTS posts_entities_idx ON posts USING gin (entities);

-- ---------------------------------------------------------------------------
-- Migration 005 — recommendation_uses: the recursion loop.
--
-- Jay's core ask: the tool must know when a post came from its own
-- recommendation vs. organically, keep score of what it drove, and learn from
-- whether that post did well. "If I use integration-announcement → Tron and
-- push it, it should know you did it based on its recommendation, count it, and
-- know if it did well afterwards — and adjust its recommendation."
--
-- Flow: operator clicks "Mark as used" on a recommendation → an OPEN row here.
-- At the next sync, attributeUses() matches a newly-ingested @eco post of the
-- same pillar (and chain, if one was chosen) published after used_at to that
-- open row → status 'matched', matched_post_id set. The post's performance then
-- rides on the normal metric_snapshots, so History can show used → posted →
-- impressions, and scoring can discount pillars whose rec-driven posts flop.
--
-- We deliberately DON'T take credit for organic posts: a matching post only
-- counts as attributed if an open use was waiting for it. Credit where due.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recommendation_uses (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template          content_template NOT NULL,        -- pillar the operator chose to act on
  chain             text,                              -- chosen chain angle (canonical id), or null
  angle             text,                              -- optional free-text topic/angle note
  score_at_use      integer,                           -- the 0..100 priority score when used (calibration)
  suggested_post_id text REFERENCES posts(id) ON DELETE SET NULL, -- the proven post it suggested, if any

  status            text NOT NULL DEFAULT 'open',      -- 'open' | 'matched' | 'dismissed'
  matched_post_id   text REFERENCES posts(id) ON DELETE SET NULL, -- resulting @eco post, once attributed
  matched_at        timestamptz,

  used_by           text NOT NULL DEFAULT 'public',    -- operator email once auth lands
  used_at           timestamptz NOT NULL DEFAULT now(),
  note              text
);
CREATE INDEX IF NOT EXISTS rec_uses_status_idx   ON recommendation_uses (status);
CREATE INDEX IF NOT EXISTS rec_uses_template_idx ON recommendation_uses (template);
CREATE INDEX IF NOT EXISTS rec_uses_used_at_idx  ON recommendation_uses (used_at DESC);
-- Never attribute the same post to two different uses.
CREATE UNIQUE INDEX IF NOT EXISTS rec_uses_matched_uidx
  ON recommendation_uses (matched_post_id) WHERE matched_post_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Migration 006 — the ARTICLE registry.
--
-- Robert's finding, confirmed against the corpus: both Thought Leadership and
-- Product Posts re-amplify the SAME underlying article over and over, and the
-- tracker was reading every amplifier as a separate article. 16 thought-
-- leadership posts collapse to ~10 distinct sources (five sources carry 11 of
-- them); 28 of the 36 product posts trace back to just 7 blog articles
-- (Verified Liquidity x6, Flash Intents x5, Programmable Addresses x5,
-- Routes-trustless x5, Routes-hardest-problem x3, Permit3 x2, Any-to-Any x2).
--
-- So the article — not the post — is the unit the shelf should rank, and
-- "how many times have we used this?" becomes a first-class number.
--
-- Seeded deterministically from the blog PDFs on disk (scripts/ingest-articles.ts):
-- page 1 of every eco.com/blog print-to-PDF carries title, dek, author, date and
-- the canonical URL in the footer. No LLM needed for the seed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS articles (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug           text NOT NULL UNIQUE,      -- eco.com/blog slug, or a synthetic key
  title          text NOT NULL,
  dek            text,                      -- the standfirst line under the headline
  author         text,
  published_on   date,
  canonical_url  text,                      -- https://eco.com/blog/<slug>/
  x_article_url  text,                      -- http://x.com/i/article/<id>, when one exists
  -- The @eco post that CARRIED this article (the bare-link post whose link_title
  -- is the article title). Amplifiers link at this post, not at the article URL,
  -- so it is the join key for the anchor rung of the attribution ladder.
  anchor_post_id text REFERENCES posts(id) ON DELETE SET NULL,
  kind           text NOT NULL,             -- 'product' | 'thought_leadership'
  product        text,                      -- lib/products.ts id, for product articles
  body           text,                      -- extracted article text; feeds the drafter
  source_file    text,                      -- the PDF this row was seeded from
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS articles_kind_idx    ON articles (kind);
CREATE INDEX IF NOT EXISTS articles_product_idx ON articles (product);

-- Which article a post is amplifying, and how we worked that out. Precedence:
--   'url'    — canonical eco.com/blog URL matched outright
--   'xurl'   — x.com/i/article/<id> matched articles.x_article_url
--   'anchor' — post links at an @eco status that already resolved to an article
--   'claude' — matched on content by the LLM, above threshold
--   'human'  — an operator said so; never overwritten by a re-run
ALTER TABLE posts ADD COLUMN IF NOT EXISTS article_id         bigint REFERENCES articles(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS article_match      text;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS article_confidence real;
CREATE INDEX IF NOT EXISTS posts_article_idx ON posts (article_id);

-- Which Eco PRODUCT(s) a post is about. The axis Product Posts actually rotates
-- on — 34 of 36 posts in that pillar carry no chain tag at all, so the old
-- chain-angle targeting was landing on nothing. Extracted at ingest alongside
-- chains/entities (lib/dimensions.ts -> lib/products.ts).
ALTER TABLE posts ADD COLUMN IF NOT EXISTS products text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS posts_products_idx ON posts USING gin (products);

-- ---------------------------------------------------------------------------
-- Migration 007 — QUOTE DISCOVERY (see Desktop/quote-discovery-spec.md).
--
-- The Quote Card pillar has nothing to re-run: a quote card is used once. So its
-- expanded section is a DISCOVERY pipeline, not a shelf. It finds usable,
-- verbatim, attributable stablecoin quotes from credible people at credible
-- organizations and drops them in a human review queue.
--
-- Precision beats recall here. A hallucinated or paraphrased quote attributed to
-- a named executive is a brand incident, not a bug — so every candidate passes a
-- verbatim check against the persisted source before it can reach the queue.
-- ---------------------------------------------------------------------------

-- The credibility filter. This table IS the quality control.
CREATE TABLE IF NOT EXISTS orgs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  org_tier      smallint NOT NULL,          -- 1 = TradFi/global brand, 2 = major stablecoin/fintech, 3 = crypto infra
  is_competitor boolean NOT NULL DEFAULT false,
  x_handle      text,
  li_handle     text,
  notes         text
);

CREATE TABLE IF NOT EXISTS people (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  full_name    text NOT NULL,
  title        text NOT NULL,
  org_id       bigint REFERENCES orgs(id) ON DELETE SET NULL,
  seniority    smallint NOT NULL,           -- 1 = C-suite/founder, 2 = SVP/MD/Head of, 3 = Director/PM
  x_handle     text,
  x_author_id  text,                        -- cached forever. never re-resolve: saves $0.010/lookup.
  li_handle    text,
  yt_channel   text,
  x_since_id   text,                        -- newest tweet id already fetched, per author (incremental runs)
  handles_verified_at timestamptz,          -- handles drift; re-verify quarterly
  active       boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS people_x_handle_uidx ON people (lower(x_handle)) WHERE x_handle IS NOT NULL;

-- Sources we monitor that aren't tied to one person (podcasts, conference
-- channels, report publishers, standing keyword searches).
CREATE TABLE IF NOT EXISTS watch_sources (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         text NOT NULL,               -- 'yt_channel' | 'podcast_rss' | 'report_site' | 'x_search'
  identifier   text NOT NULL,               -- channel id, rss url, domain, or search query
  label        text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  last_run_at  timestamptz,
  UNIQUE (kind, identifier)
);

CREATE TABLE IF NOT EXISTS discovery_runs (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  triggered_by   text NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  status         text NOT NULL DEFAULT 'queued',   -- queued|running|partial|complete|failed
  lookback_days  int NOT NULL DEFAULT 365,
  budget_cents   int NOT NULL DEFAULT 500,
  spend_cents    numeric(10,2) NOT NULL DEFAULT 0,
  lane_status    jsonb NOT NULL DEFAULT '{}',      -- {"x":"complete","youtube":"running","web":"queued"}
  stats          jsonb NOT NULL DEFAULT '{}',      -- per-lane docs fetched / candidates / verify failures
  errors         jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS discovery_runs_started_idx ON discovery_runs (started_at DESC);

-- Live progress for the run in flight: which lane, which step, how far through
-- it. A run is minutes long, so the UI needs something finer than lane_status
-- to show between one lane finishing and the next one landing.
-- {"lane":"youtube","step":"transcribe","done":2,"total":7,"note":"...","laneStartedAt":"..."}
ALTER TABLE discovery_runs ADD COLUMN IF NOT EXISTS progress jsonb NOT NULL DEFAULT '{}';

-- Persist everything we fetch. Verification reads from here, and it stops us
-- re-paying for the same data on the next run.
CREATE TABLE IF NOT EXISTS raw_documents (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id         bigint REFERENCES discovery_runs(id) ON DELETE SET NULL,
  source_kind    text NOT NULL,            -- 'x_post' | 'youtube' | 'article' | 'report'
  source_url     text NOT NULL,
  external_id    text,                     -- tweet id, yt video id, url hash
  published_at   timestamptz,
  title          text,
  body           text NOT NULL,            -- full post text, transcript, or article text
  segments       jsonb,                    -- [{speaker,start_sec,end_sec,text}] for diarized media
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, external_id)
);
CREATE INDEX IF NOT EXISTS raw_documents_run_idx ON raw_documents (run_id);

CREATE TABLE IF NOT EXISTS quote_candidates (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id            bigint REFERENCES discovery_runs(id) ON DELETE SET NULL,
  raw_document_id   bigint REFERENCES raw_documents(id) ON DELETE CASCADE,
  quote_text        text NOT NULL,
  quote_hash        text NOT NULL,          -- sha256 of the normalized quote; dedupe across runs
  speaker_name      text NOT NULL,
  speaker_title     text,
  org_name          text,                   -- org as stated in the source (may not be in orgs yet)
  person_id         bigint REFERENCES people(id) ON DELETE SET NULL,
  org_id            bigint REFERENCES orgs(id) ON DELETE SET NULL,
  said_at           timestamptz,
  deep_link         text NOT NULL,          -- ?t=NNN for YT, #:~:text= for web, post url for X
  context_before    text,
  context_after     text,
  topic_tags        text[] NOT NULL DEFAULT '{}',
  verification      text NOT NULL,          -- 'exact' | 'fuzzy' | 'failed'
  score             numeric(5,2),
  score_breakdown   jsonb,
  pillar_tag        text,                   -- 'A' | 'B' | 'C' | 'D' (narrative pillars)
  disqualifiers     text[] NOT NULL DEFAULT '{}',
  status            text NOT NULL DEFAULT 'candidate',
                    -- candidate | approved | rejected | carded | posted
  reviewed_by       text,
  reviewed_at       timestamptz,
  reject_reason     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- A quote reviewed and rejected once must never resurface. Single highest-value
-- thing in the schema for reviewer sanity.
CREATE UNIQUE INDEX IF NOT EXISTS quote_candidates_hash_uidx ON quote_candidates (quote_hash);
CREATE INDEX IF NOT EXISTS quote_candidates_queue_idx ON quote_candidates (status, score DESC);
CREATE INDEX IF NOT EXISTS quote_candidates_run_idx   ON quote_candidates (run_id);

-- Names surfaced by the 7-day keyword sweep who aren't on the roster yet. The
-- sweep is roster-DISCOVERY, not a quote source: it keeps the expensive read
-- budget pointed at people we've already vetted.
CREATE TABLE IF NOT EXISTS roster_suggestions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  x_handle      text NOT NULL UNIQUE,
  x_author_id   text,
  display_name  text,
  bio           text,
  followers     integer,
  seen_count    integer NOT NULL DEFAULT 1,
  sample_post   text,
  sample_url    text,
  status        text NOT NULL DEFAULT 'new',   -- new | added | ignored
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS roster_suggestions_status_idx ON roster_suggestions (status, seen_count DESC);

-- Which of the seven product-post SHAPES a post takes (launch, problem →
-- mechanism, how-it-works, diagram, partner proof, ICP objection, article
-- amplifier). Deterministic, see detectShape() in lib/products.ts. Lets the
-- Prioritize card say "you've run problem → mechanism five times straight for
-- this product" instead of offering the same angle again.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS shape text;
CREATE INDEX IF NOT EXISTS posts_shape_idx ON posts (shape);

-- ---------------------------------------------------------------------------
-- Migration 008 — the DOCS PAGE registry (Dev Doc Post) and the VIDEO registry
-- (Short-Form Video). Both pillars were stuck on draftMode 'generic' — a single
-- "draft something fresh" button — because neither had a shelf of source
-- material to rank. They do now.
--
-- DOCS. Every dev-doc post is built around a section of docs.eco.com. The site
-- publishes llms.txt: a curated, section-grouped index of every page with a
-- one-line description written by the docs team, plus an .md twin of each page.
-- So the shelf seeds itself from the docs site and re-syncs on the normal cron —
-- no scraping, no manual list to maintain.
--
-- The evidence that made this worth building: of 73 pages in llms.txt, SEVEN
-- have ever been used in a post. And the pages we do use beat the homepage
-- decisively — deep-linked posts run a 934 median impression, /home posts 460.
-- The pillar's whole problem was that it kept reaching for docs.eco.com/home.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doc_pages (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  url           text NOT NULL UNIQUE,      -- canonical https://docs.eco.com/<path>, no .md, no query
  path          text NOT NULL,             -- /routes/integrate/cli
  section       text NOT NULL,             -- llms.txt "## " heading this page sits under
  title         text NOT NULL,             -- llms.txt link text
  blurb         text,                      -- the docs team's own one-liner
  body          text,                      -- the .md page text; feeds the drafter
  body_fetched_at timestamptz,

  -- Claude-assigned, one pass at seed. Re-run only when llms.txt changes.
  icp           text,                      -- lib/icp.ts id — who this page is FOR
  tier          text,                      -- 'hero' | 'supporting' | 'reference'
  hook          text,                      -- one line: what is genuinely postable here
  tagged_at     timestamptz,
  tag_source    text,                      -- 'claude' | 'human'

  active        boolean NOT NULL DEFAULT true,  -- false once it drops out of llms.txt
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS doc_pages_icp_idx     ON doc_pages (icp);
CREATE INDEX IF NOT EXISTS doc_pages_tier_idx    ON doc_pages (tier);
CREATE INDEX IF NOT EXISTS doc_pages_section_idx ON doc_pages (section);

-- Which docs page a post drove to. Deterministic for 17 of 25 existing dev-doc
-- posts (link_resolved_url carries the URL outright); the rest are the CLI
-- photo-posts, matched by Claude or left in the residual row.
--   'url'    — link_resolved_url matched a doc_pages.url
--   'claude' — matched on content, above threshold
--   'human'  — an operator said so; never overwritten by a re-run
ALTER TABLE posts ADD COLUMN IF NOT EXISTS doc_page_id     bigint REFERENCES doc_pages(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS doc_page_match  text;
CREATE INDEX IF NOT EXISTS posts_doc_page_idx ON posts (doc_page_id);

-- ---------------------------------------------------------------------------
-- VIDEOS. The short-form pillar had the same shape of problem and a much bigger
-- gap: the @ecoprotocol YouTube channel holds 280 shorts; 58 have ever run on X.
-- The shelf is the residual — clips that exist and have never been posted.
--
-- Two sources, deliberately merged rather than picking one:
--   youtube — 280 clips with title, a real summary description, and view counts
--   dropbox — the team's delivery folder: fewer clips, but it carries the file
--             itself (download link for posting) and the human quality verdict
--             encoded in the folder tree ("Weak (Don't Use)")
-- A clip can come from either or both; dropbox_path/yt_video_id are both
-- nullable and either one alone is a valid row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS videos (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- YouTube side.
  yt_video_id    text UNIQUE,               -- null = exists in Dropbox only
  yt_url         text,
  yt_published_on date,
  yt_views       integer,
  yt_thumb_url   text,

  -- Dropbox side.
  dropbox_file_id text UNIQUE,              -- id:AbCd-_12; null = YouTube only
  dropbox_path    text,
  dropbox_folder  text,                     -- the delivery batch it shipped in
  dropbox_bytes   bigint,

  title          text NOT NULL,             -- YT title, else cleaned-up filename
  description    text,                      -- YT description — a real summary, not a stub
  transcript     text,                      -- from a sibling -transcript.txt, or Gemini on demand
  transcript_source text,                   -- 'dropbox_txt' | 'gemini' | null
  duration_sec   integer,

  -- Claude-assigned at seed, same pass shape as doc_pages.
  series         text,                      -- 'shah_explainer' | 'ceo_podcast' | 'brand_film' | ...
  speaker        text,                      -- 'strao' | 'rynesaxe' | 'third_party' | null
  icp            text,
  topic          text,                      -- short topic label for grouping
  hook           text,                      -- the line worth building a post around
  tagged_at      timestamptz,
  tag_source     text,

  -- The team's own verdict, read off the Dropbox folder tree. A clip filed under
  -- "Weak (Don't Use)" must never be recommended — that is a human judgment we
  -- already have and should not second-guess.
  do_not_use     boolean NOT NULL DEFAULT false,

  active         boolean NOT NULL DEFAULT true,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS videos_series_idx  ON videos (series);
CREATE INDEX IF NOT EXISTS videos_icp_idx     ON videos (icp);
CREATE INDEX IF NOT EXISTS videos_pub_idx     ON videos (yt_published_on DESC);

-- Which clip a short-form post used. Almost never deterministic — only 1 of 58
-- posts links YouTube at all, because the video is uploaded natively to X. So
-- this is a Claude match over a +/-14 day window on title+description vs. post
-- text, confidence-gated, with the same 'human' precedence as everywhere else.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS video_id         bigint REFERENCES videos(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS video_match      text;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS video_confidence real;
CREATE INDEX IF NOT EXISTS posts_video_idx ON posts (video_id);
