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
