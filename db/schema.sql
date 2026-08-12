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

  -- Post shape. Pure reposts are excluded from ingestion entirely; self-replies
  -- are KEPT and flagged (we use them for CTAs) but excluded from template stats.
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
