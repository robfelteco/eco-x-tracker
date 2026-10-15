import { sql } from "./db.ts";
import {
  resolveHandle,
  fetchUserTweets,
  fetchPublicMetrics,
  fetchNonPublicMetrics,
  takeReadCount,
  type XPost,
  type PublicMetrics,
} from "./twitter.ts";
import { runRuleClassification, runClaudeClassification } from "./classify.ts";
import { enrichByIds, enrichQuotedImages } from "./enrich.ts";
import { extractDimensions, EMPTY_VOCAB, type ExtraVocab } from "./dimensions.ts";
import { getLaneRegistry } from "./laneRegistry.ts";
import { detectLanes } from "./laneDetect.ts";
import { detectAnalog } from "./analogs.ts";

// Posts younger than this are eligible for a non_public_metrics attempt and for
// daily re-snapshotting (metrics move fast early, then settle).
const RECENT_DAYS = 30;
const SNAPSHOT_TAPER_DAYS = 14; // only re-snapshot posts <14d old on daily runs (cost control)
const PER_READ_USD = Number(process.env.X_API_COST_PER_READ_USD || 0.005);

export interface SyncResult {
  ok: boolean;
  postsAdded: number;
  postsUpdated: number;
  snapshots: number;
  xReads: number;
  estCostUsd: number;
  summary: string;
  errors: string[];
  /** Lanes the sync registered for subjects it had no lane for. */
  lanes: { created: number; widened: number; retagged: number; labels: string[] };
}

// Upsert a batch of posts. Preserves the manual `amplified` flag and any human
// classification already on the row (COALESCE / no-clobber on those columns).
async function upsertPosts(posts: XPost[], vocab: ExtraVocab = EMPTY_VOCAB): Promise<{ added: number; updated: number }> {
  let added = 0;
  let updated = 0;
  for (const p of posts) {
    // X native Article content arrives inline with the timeline — write it to the
    // link_* card columns and stamp enriched_at so link-scraping skips it. Only
    // set enriched_at when we actually have article content (never clobber an
    // existing external-link card with nulls on a re-ingest).
    const hasArticle = !!(p.link_title || p.link_image_url);
    // Chain / entity / PRODUCT sub-dimensions — deterministic, recomputed on
    // every upsert so a widened vocabulary takes effect on the next sync. The
    // vocabulary is now two sources: the code registries compiled into
    // lib/dimensions.ts and lib/products.ts, and the `lane_registry` rows read
    // once at the top of this sync (Migration 019), so a lane added yesterday
    // tags today without a deploy.
    const dim = extractDimensions(
      {
        text: p.text,
        mentions: p.mentions,
        domains: p.domains,
        mediaType: p.mediaType,
        linkTitle: p.link_title,
      },
      vocab,
    );
    // Which tradfi analog concept, if any, this post actually teaches. Runs over
    // the link card too — an external explainer's title is usually where the
    // concept name lives, not in our own copy above it. Recomputed on every
    // upsert like the other dimensions, so widening lib/analogs.ts vocab takes
    // effect on the next sync rather than needing a backfill each time.
    const analogId = detectAnalog(
      [p.text, p.link_title, p.link_description].filter(Boolean).join(" \n "),
    );
    const rows = await sql<{ inserted: boolean }>`
      INSERT INTO posts (
        id, url, created_at, text, urls, domains, mentions, hashtags,
        media_type, media_urls, preview_image_url,
        is_reply, is_self_reply, is_quote,
        link_title, link_description, link_image_url, quoted_image_url,
        quoted_post_id,
        chains, entities, products, shape, analog_id,
        enriched_at, updated_at
      ) VALUES (
        ${p.id}, ${p.url}, ${p.created_at}, ${p.text},
        ${JSON.stringify(p.urls)}, ${p.domains}, ${p.mentions}, ${p.hashtags},
        ${p.mediaType}, ${JSON.stringify(p.media_urls)}, ${p.preview_image_url},
        ${p.is_reply}, ${p.is_self_reply}, ${p.is_quote},
        ${p.link_title}, ${p.link_description}, ${p.link_image_url}, ${p.quoted_image_url},
        ${p.quoted_post_id},
        ${dim.chains}, ${dim.entities}, ${dim.products}, ${dim.shape}, ${analogId},
        ${hasArticle ? new Date().toISOString() : null}, now()
      )
      ON CONFLICT (id) DO UPDATE SET
        text = EXCLUDED.text,
        urls = EXCLUDED.urls,
        domains = EXCLUDED.domains,
        mentions = EXCLUDED.mentions,
        hashtags = EXCLUDED.hashtags,
        media_type = EXCLUDED.media_type,
        media_urls = EXCLUDED.media_urls,
        preview_image_url = EXCLUDED.preview_image_url,
        is_reply = EXCLUDED.is_reply,
        is_self_reply = EXCLUDED.is_self_reply,
        is_quote = EXCLUDED.is_quote,
        chains = EXCLUDED.chains,
        entities = EXCLUDED.entities,
        products = EXCLUDED.products,
        shape = EXCLUDED.shape,
        analog_id = EXCLUDED.analog_id,
        link_title = COALESCE(EXCLUDED.link_title, posts.link_title),
        link_description = COALESCE(EXCLUDED.link_description, posts.link_description),
        link_image_url = COALESCE(EXCLUDED.link_image_url, posts.link_image_url),
        quoted_image_url = COALESCE(EXCLUDED.quoted_image_url, posts.quoted_image_url),
        quoted_post_id = COALESCE(EXCLUDED.quoted_post_id, posts.quoted_post_id),
        enriched_at = COALESCE(EXCLUDED.enriched_at, posts.enriched_at),
        updated_at = now()
      RETURNING (xmax = 0) AS inserted
    `;
    if (rows[0]?.inserted) added++;
    else updated++;
  }
  return { added, updated };
}

// Widen each post's chain / entity / product tags with what its link card says.
// Union, never replace: the body-only tags are already correct, the card can
// only add to them.
async function retagFromCards(ids: string[], vocab: ExtraVocab): Promise<void> {
  if (!ids.length) return;
  const rows = await sql<{
    id: string;
    text: string;
    mentions: string[];
    domains: string[];
    media_type: string;
    link_title: string | null;
    link_description: string | null;
    chains: string[];
    entities: string[];
    products: string[];
  }>`
    SELECT id, text, mentions, domains, media_type, link_title, link_description, chains, entities, products
    FROM posts WHERE id = ANY(${ids}) AND link_title IS NOT NULL`;
  const union = (a: string[], b: string[]) => [...new Set([...(a ?? []), ...b])].sort();
  for (const r of rows) {
    const dim = extractDimensions(
      {
        text: [r.text, r.link_title, r.link_description].filter(Boolean).join(" \n "),
        mentions: r.mentions,
        domains: r.domains,
        mediaType: r.media_type,
        linkTitle: r.link_title,
      },
      vocab,
    );
    const chains = union(r.chains, dim.chains);
    const entities = union(r.entities, dim.entities);
    const products = union(r.products, dim.products);
    if (
      chains.length === (r.chains ?? []).length &&
      entities.length === (r.entities ?? []).length &&
      products.length === (r.products ?? []).length
    ) continue;
    await sql`UPDATE posts SET chains = ${chains}, entities = ${entities}, products = ${products} WHERE id = ${r.id}`;
  }
}

// Append one metric snapshot per post, deduped to one per UTC day. A second run
// on the same day updates that day's row (numbers only grow) instead of adding.
async function writeSnapshots(
  pub: PublicMetrics[],
  nonPub: Map<string, { url_link_clicks: number | null; user_profile_clicks: number | null }>,
): Promise<number> {
  let n = 0;
  for (const m of pub) {
    const np = nonPub.get(m.id);
    const available = !!np && (np.url_link_clicks != null || np.user_profile_clicks != null);
    await sql`
      INSERT INTO metric_snapshots (
        post_id, impressions, likes, replies, retweets, quotes, bookmarks,
        url_link_clicks, user_profile_clicks, non_public_available
      ) VALUES (
        ${m.id}, ${m.impressions}, ${m.likes}, ${m.replies}, ${m.retweets},
        ${m.quotes}, ${m.bookmarks},
        ${np?.url_link_clicks ?? null}, ${np?.user_profile_clicks ?? null}, ${available}
      )
      ON CONFLICT (post_id, fetched_on) DO UPDATE SET
        fetched_at = now(),
        impressions = EXCLUDED.impressions,
        likes = EXCLUDED.likes,
        replies = EXCLUDED.replies,
        retweets = EXCLUDED.retweets,
        quotes = EXCLUDED.quotes,
        bookmarks = EXCLUDED.bookmarks,
        url_link_clicks = COALESCE(EXCLUDED.url_link_clicks, metric_snapshots.url_link_clicks),
        user_profile_clicks = COALESCE(EXCLUDED.user_profile_clicks, metric_snapshots.user_profile_clicks),
        non_public_available = metric_snapshots.non_public_available OR EXCLUDED.non_public_available
    `;
    n++;
  }
  return n;
}

async function highestStoredId(): Promise<string | null> {
  // Tweet ids are monotonic snowflakes; MAX by numeric length then lexical works
  // but ::numeric is exact. Stored as text, so cast for the comparison.
  const rows = await sql<{ id: string }>`SELECT id FROM posts ORDER BY id::numeric DESC LIMIT 1`;
  return rows[0]?.id ?? null;
}

/**
 * Run a sync. `backfill` pages deep (up to ~3,200); otherwise incremental from
 * the highest stored id. Snapshots metrics for the fetched posts plus recent
 * already-stored posts (so their growth curve keeps filling even on quiet days).
 */
export async function runSync(opts: {
  trigger: "cron" | "manual";
  backfill?: boolean;
  count?: number;
}): Promise<SyncResult> {
  const errors: string[] = [];
  const handle = process.env.X_ACCOUNT_HANDLE || "eco";

  const runRows = await sql<{ id: number }>`
    INSERT INTO sync_runs (trigger) VALUES (${opts.trigger}) RETURNING id
  `;
  const runId = runRows[0].id;

  let postsAdded = 0;
  let postsUpdated = 0;
  let snapshots = 0;
  let classified = 0;
  let enriched = 0;
  let ok = true;
  const lanes = { created: 0, widened: 0, retagged: 0, labels: [] as string[] };

  // The lane vocabulary for this run. Read once, before anything is written, so
  // every post in the batch is tagged against the same registry.
  let vocab = EMPTY_VOCAB;
  try {
    vocab = (await getLaneRegistry(sql)).vocab;
  } catch (err) {
    errors.push(`lane registry: ${err instanceof Error ? err.message.slice(0, 150) : String(err)}`);
  }

  try {
    const { id: userId } = await resolveHandle(handle);

    // Backfill reaches back to BACKFILL_SINCE (default Jan 1 2026); incremental
    // runs pull only what's newer than the highest stored id.
    const backfillSince = process.env.BACKFILL_SINCE || "2026-01-01T00:00:00Z";
    const sinceId = opts.backfill ? undefined : (await highestStoredId()) ?? undefined;
    const fetched = await fetchUserTweets(userId, {
      count: opts.count ?? (opts.backfill ? 2000 : 100),
      sinceId,
      startTime: opts.backfill ? backfillSince : undefined,
      maxPages: opts.backfill ? 20 : 3,
    });

    if (fetched.length) {
      const up = await upsertPosts(fetched, vocab);
      postsAdded = up.added;
      postsUpdated = up.updated;

      // Enrich outbound links (resolve t.co + scrape OG card) BEFORE classifying,
      // so article posts arrive with readable title/description + a thumbnail.
      // Self-filters to main posts that aren't enriched yet — cheap HTTP only.
      try {
        enriched = await enrichByIds(fetched.map((p) => p.id));
      } catch (err) {
        errors.push(`enrich: ${err instanceof Error ? err.message.slice(0, 150) : String(err)}`);
      }

      // Re-tag now that link cards exist. An article-amplifier post's body is a
      // bare t.co, so the upsert above tagged it from nothing: the product lives
      // in the card title ("Programmable Addresses V2: ..."). Without this the
      // post is filed under the right pillar and feeds no lane.
      try {
        await retagFromCards(fetched.map((p) => p.id), vocab);
      } catch (err) {
        errors.push(`retag: ${err instanceof Error ? err.message.slice(0, 150) : String(err)}`);
      }

      // Quote posts: native quoted media resolves for free inline (see
      // mapRawToPost), but a quoted X-article cover needs a direct fetch — fill
      // those here (one billed read each, rare). Best-effort.
      try {
        await enrichQuotedImages(fetched.filter((p) => p.is_quote).map((p) => p.id));
      } catch (err) {
        errors.push(`quoted-img: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
      }
    }

    const fetchedIds = new Set(fetched.map((p) => p.id));
    const recentCutoff = Date.now() - RECENT_DAYS * 86_400_000;
    type Np = { url_link_clicks: number | null; user_profile_clicks: number | null };

    // 1) Snapshot freshly-fetched posts from the INLINE timeline metrics — no
    //    extra billed read. Enrich <30d posts with non_public clicks (user
    //    context only; app-only bearer returns none, at no cost).
    if (fetched.length) {
      const npEligible = fetched
        .filter((p) => new Date(p.created_at).getTime() > recentCutoff)
        .map((p) => p.id);
      const npMap = new Map<string, Np>();
      for (let i = 0; i < npEligible.length; i += 100) {
        try {
          for (const x of await fetchNonPublicMetrics(npEligible.slice(i, i + 100))) npMap.set(x.id, x);
        } catch {
          /* non_public is best-effort */
        }
      }
      snapshots += await writeSnapshots(
        fetched.map((p) => p.metrics),
        npMap,
      );
    }

    // 2) Re-snapshot recent STORED posts we did NOT just fetch, so their growth
    //    curves keep filling on quiet days. These are the only extra reads.
    const staleRows = await sql<{ id: string; created_at: string }>`
      SELECT id, created_at FROM posts
      WHERE created_at > now() - (${SNAPSHOT_TAPER_DAYS} || ' days')::interval
        AND is_reply = false
    `;
    const stale = staleRows.filter((r) => !fetchedIds.has(r.id));
    for (let i = 0; i < stale.length; i += 100) {
      const batch = stale.slice(i, i + 100);
      const ids = batch.map((r) => r.id);
      try {
        const pub = await fetchPublicMetrics(ids);
        const npIds = batch.filter((r) => new Date(r.created_at).getTime() > recentCutoff).map((r) => r.id);
        const npList = npIds.length ? await fetchNonPublicMetrics(npIds) : [];
        const npMap = new Map<string, Np>(npList.map((x) => [x.id, x]));
        snapshots += await writeSnapshots(pub, npMap);
      } catch (err) {
        ok = false;
        errors.push(err instanceof Error ? err.message.slice(0, 300) : String(err));
        if (/402|CreditsDepleted|SpendCap/i.test(String(err))) break; // stop burning on billing errors
      }
    }

    // 3) Pre-classify newly-added posts so they arrive with a template. Rules are
    //    free; Claude runs only on what the rules can't settle. Best-effort — a
    //    classification hiccup (e.g. missing ANTHROPIC_API_KEY) never fails a sync.
    if (postsAdded > 0) {
      try {
        await runRuleClassification();
        const c = await runClaudeClassification(Math.min(200, postsAdded * 2));
        classified = c.classified;
        if (c.errors.length) errors.push(...c.errors.slice(0, 2).map((e) => `classify: ${e}`));
      } catch (err) {
        errors.push(`classify: ${err instanceof Error ? err.message.slice(0, 150) : String(err)}`);
      }
    }

    // 4) LANE DETECTION. Classification just filed the new posts into pillars;
    //    this asks whether any of them is about a subject the registry has no
    //    lane for, and registers it if so. It has to run AFTER classification —
    //    the question "is this an integration announcement with no chain" can
    //    only be asked once the template is on the row.
    //
    //    Best-effort in exactly the same way classification is: a sync that
    //    pulled posts and snapshots successfully has done its job, and a lane
    //    that did not get drawn today gets drawn on the next run.
    try {
      const d = await detectLanes(sql);
      lanes.created = d.created.length;
      lanes.widened = d.widened.length;
      lanes.retagged = d.retagged;
      lanes.labels = d.created.map((l) => `${l.label} (${l.kind})`);
      if (d.errors.length) errors.push(...d.errors.slice(0, 2).map((e) => `lanes: ${e}`));
    } catch (err) {
      errors.push(`lanes: ${err instanceof Error ? err.message.slice(0, 150) : String(err)}`);
    }
  } catch (err) {
    ok = false;
    errors.push(err instanceof Error ? err.message.slice(0, 300) : String(err));
  }

  const xReads = takeReadCount();
  const estCost = Number((xReads * PER_READ_USD).toFixed(4));
  const summary =
    `${postsAdded} new · ${postsUpdated} updated · ${snapshots} snapshots` +
    (enriched ? ` · ${enriched} enriched` : "") +
    (classified ? ` · ${classified} classified` : "") +
    (lanes.created ? ` · ${lanes.created} new lane${lanes.created === 1 ? "" : "s"} (${lanes.labels.join(", ")})` : "") +
    (lanes.retagged ? ` · ${lanes.retagged} re-tagged` : "") +
    ` · ${xReads} X reads (~$${estCost})` +
    (errors.length ? ` · ${errors.length} error(s)` : "");

  await sql`
    UPDATE sync_runs SET
      finished_at = now(), ok = ${ok},
      posts_added = ${postsAdded}, posts_updated = ${postsUpdated},
      snapshots = ${snapshots}, classified = ${classified},
      x_reads = ${xReads}, est_cost_usd = ${estCost},
      summary = ${summary}, errors = ${JSON.stringify(errors)}
    WHERE id = ${runId}
  `;

  return { ok, postsAdded, postsUpdated, snapshots, xReads, estCostUsd: estCost, summary, errors, lanes };
}
