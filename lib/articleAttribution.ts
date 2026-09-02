import {
  ecoBlogSlug,
  xArticleId,
  ecoStatusId,
  anyStatusUrl,
  titleSimilarity,
  TITLE_MATCH_THRESHOLD,
} from "./articleKeys.ts";

// Tie every post to the article it is amplifying.
//
// The problem this solves: @eco publishes an article once, then points at it
// from four or five more posts over the following weeks. Those amplifiers do
// NOT link to the article URL — they link to the @eco STATUS that carried it.
// So the tracker was reading each one as a brand-new article, which is what
// made the Thought Leadership shelf unusable and the Product Posts shelf worse.
//
// The ladder, most-certain rung first. Every rung is deterministic except the
// last, and the last one is grouped so that N posts sharing a link get ONE
// answer rather than N independent guesses.
//
//   url    — an eco.com/blog/<slug> link matching articles.slug
//   xurl   — an x.com/i/article/<id> link, tied to an article by its card title
//   anchor — a link at an @eco status that has itself already resolved
//   claude — content match against the registry, above threshold
//   human  — an operator said so. Never overwritten by a re-run.
//
// The sql tag is injected so this module stays dependency-free and can be run
// both from the app (lib/db) and from a standalone backfill script over pg.

export type SqlTag = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...params: unknown[]
) => Promise<T[]>;

export interface AttributionPost {
  id: string;
  text: string;
  template: string | null;
  link_title: string | null;
  created_at: string;
  urls: string[]; // every expanded/resolved outbound URL, lowercased
  quoted_post_id: string | null; // the tweet this one quotes (Migration 015)
}

export interface ArticleLite {
  id: number;
  slug: string;
  title: string;
  dek: string | null;
  kind: string;
  published_on: string | null;
  canonical_url: string | null;
  x_article_url: string | null;
  anchor_post_id: string | null;
  body: string | null;
}

export interface AttributionResult {
  scanned: number;
  matched: Record<string, number>; // by rung
  unmatched: number;
  anchorsResolved: number;
  claudeGroups: number;
  claudeCostUsd: number;
  prePublishRejected: number; // content matches thrown out by the date guard
  errors: string[];
}

// Which pillars can carry an article link at all.
//
// This list used to be the four pillars that sit ON articles, on the reasoning
// that a data visual or a quote card is its own artefact and has no article
// behind it. True of the artefact, false of the POST: the most common shape in
// the feed is a data-motion visual that quote-posts the chain integration
// article, and filing that under "data visuals don't have articles" is what hid
// the pairing from the scorer. The pillar clock then read New Chain
// Integrations as weeks overdue on a morning when the chain piece had just been
// back in front of the audience.
//
// So every pillar that can quote-post one of our pieces is scanned. Cost is
// unchanged: the added pillars resolve on the free deterministic rungs (a link,
// an X-article card, an anchor, a quoted id) and are excluded from
// CLAUDE_MATCH_TEMPLATES below, so none of them can reach a paid call.
export const ARTICLE_TEMPLATES = [
  "thought_leadership",
  "product_post",
  "broad_educational",
  // Chain integrations sit on articles too — an "Eco now supports X" post is
  // usually carried by a blog piece and then re-amplified for a fortnight. The
  // pillar still DRAFTS on chain angles, but the reuse count is worth having.
  "integration_announcement",
  // These three PAIR with articles rather than sitting on them — they quote-post
  // the piece. The link is what makes "we covered this subject today, in another
  // pillar" a fact the score can read (lib/articleCoverage.ts).
  "data_motion_visual",
  "quote_card",
  "short_form_video_eco",
];

// …but only these two are worth a paid content-match. Broad Educational points
// at OTHER people's articles by definition, so fanning Claude out over it would
// spend money to confirm 60-odd nulls. It stays in ARTICLE_TEMPLATES because a
// broad-ed post can still be the ANCHOR for one of our own pieces (the "$32
// Trillion" essay is filed there), and the free rungs must see it.
export const CLAUDE_MATCH_TEMPLATES = ["thought_leadership", "product_post", "integration_announcement"];

// Matches ONE GROUP of posts — all of which share an outbound link, and so are
// all amplifying the same thing — against the registry, returning one answer.
// Group-level rather than post-level on purpose: the individual posts are short
// and angled, and the most diagnostic sentence often sits in the shortest one.
// Seeing all of them together is both cheaper and materially more accurate.
type MatchFn = (
  group: AttributionPost[],
  articles: ArticleLite[],
) => Promise<{ articleId: number; confidence: number } | null>;

export async function attributeArticles(
  sql: SqlTag,
  opts: { claudeMatch?: MatchFn; templates?: string[]; claudeTemplates?: string[] } = {},
): Promise<AttributionResult> {
  const templates = opts.templates ?? ARTICLE_TEMPLATES;
  const errors: string[] = [];
  const matched: Record<string, number> = {};
  const bump = (k: string) => (matched[k] = (matched[k] ?? 0) + 1);

  // NOTE: both drivers hand back `bigint` columns as STRINGS. Normalise the id
  // to a number once, here, or every `a.id === someNumber` comparison downstream
  // silently returns false and the whole rung goes quiet instead of erroring.
  const articles = (
    await sql<ArticleLite>`
      SELECT id, slug, title, dek, kind, to_char(published_on, 'YYYY-MM-DD') AS published_on,
             canonical_url, x_article_url, anchor_post_id, body
      FROM articles`
  ).map((a) => ({ ...a, id: Number(a.id) }));
  if (!articles.length) {
    return { scanned: 0, matched, unmatched: 0, anchorsResolved: 0, claudeGroups: 0, claudeCostUsd: 0,
             prePublishRejected: 0,
             errors: ["no articles seeded — run scripts/ingest-articles.ts first"] };
  }

  const posts = await sql<AttributionPost>`
    SELECT id, text, template::text AS template, link_title, created_at, quoted_post_id,
           COALESCE(ARRAY(SELECT lower(u->>'expanded_url') FROM jsonb_array_elements(posts.urls) u
                          WHERE u->>'expanded_url' IS NOT NULL), '{}')
             || CASE WHEN link_resolved_url IS NOT NULL THEN ARRAY[lower(link_resolved_url)] ELSE '{}'::text[] END
             AS urls
    FROM posts
    WHERE is_reply = false
      AND template::text = ANY(${templates})
      AND article_match IS DISTINCT FROM 'human'`;

  const bySlug = new Map(articles.map((a) => [a.slug, a]));
  const assign = new Map<string, { articleId: number; rung: string; confidence: number }>();

  // --- Rung 1: a direct eco.com/blog link. --------------------------------
  for (const p of posts) {
    for (const u of p.urls) {
      const slug = ecoBlogSlug(u);
      const a = slug ? bySlug.get(slug) : null;
      if (a) {
        assign.set(p.id, { articleId: a.id, rung: "url", confidence: 1 });
        break;
      }
    }
  }

  // --- Rung 2: an x.com/i/article/<id> link, identified by its card title. --
  // This also teaches the registry two things it can't know from the PDF: the
  // X-article URL, and WHICH @eco post carried the article (the anchor).
  let anchorsResolved = 0;
  for (const p of posts) {
    if (assign.has(p.id)) {
      // A direct eco.com/blog post with a card title is also a legitimate
      // anchor — record it if the article doesn't have one yet.
      const a = articles.find((x) => x.id === assign.get(p.id)!.articleId);
      if (a && !a.anchor_post_id && p.link_title && titleSimilarity(p.link_title, a.title) >= TITLE_MATCH_THRESHOLD) {
        a.anchor_post_id = p.id;
        await sql`UPDATE articles SET anchor_post_id = ${p.id}, updated_at = now() WHERE id = ${a.id}`;
        anchorsResolved++;
      }
      continue;
    }
    const artUrl = p.urls.map((u) => ({ u, id: xArticleId(u) })).find((x) => x.id);
    if (!artUrl || !p.link_title) continue;
    let best: { a: ArticleLite; sim: number } | null = null;
    for (const a of articles) {
      const sim = titleSimilarity(p.link_title, a.title);
      if (sim >= TITLE_MATCH_THRESHOLD && (!best || sim > best.sim)) best = { a, sim };
    }
    if (!best) continue;
    assign.set(p.id, { articleId: best.a.id, rung: "xurl", confidence: best.sim });
    await sql`
      UPDATE articles
      SET x_article_url = COALESCE(x_article_url, ${artUrl.u}),
          anchor_post_id = COALESCE(anchor_post_id, ${p.id}),
          updated_at = now()
      WHERE id = ${best.a.id}`;
    if (!best.a.anchor_post_id) {
      best.a.anchor_post_id = p.id;
      anchorsResolved++;
    }
    best.a.x_article_url = best.a.x_article_url ?? artUrl.u;
  }

  // --- Rung 3: a reference to an @eco status that has itself resolved. -----
  //
  // Two ways a post can point at another @eco post, and they need different
  // reads. A LINK shows up in entities.urls. A QUOTE does not: the only x.com
  // URL on a quote post is its own media (x.com/eco/status/<own id>/video/1),
  // and the reference lives in referenced_tweets, which is why quoted_post_id
  // is persisted (Migration 015). Both resolve the same way once you have the
  // id, so they share one loop.
  //
  // Iterated, because an anchor may only have resolved on this very pass.
  const resolveStatus = (sid: string): number | undefined => {
    // The referenced status is itself a post we've attributed…
    const viaPost = assign.get(sid);
    // …or it is registered as an article's anchor.
    const viaAnchor = articles.find((a) => a.anchor_post_id === sid);
    return viaPost?.articleId ?? viaAnchor?.id;
  };
  for (let round = 0; round < 3; round++) {
    let changed = 0;
    for (const p of posts) {
      if (assign.has(p.id)) continue;
      // Quoted id first — it is an exact reference, where a link has to be
      // parsed out of a URL that might be the post's own media.
      const quotedId = p.quoted_post_id;
      const viaQuote = quotedId ? resolveStatus(quotedId) : undefined;
      if (viaQuote) {
        assign.set(p.id, { articleId: viaQuote, rung: "quoted", confidence: 0.95 });
        changed++;
        continue;
      }
      for (const u of p.urls) {
        const sid = ecoStatusId(u);
        // A quote post's own media URL parses as an @eco status — its own. It
        // is not a reference to anything and must not resolve.
        if (!sid || sid === p.id) continue;
        const articleId = resolveStatus(sid);
        if (articleId) {
          assign.set(p.id, { articleId, rung: "anchor", confidence: 0.95 });
          changed++;
          break;
        }
      }
    }
    if (!changed) break;
  }

  // --- Rung 4: content match, grouped by the link they share. --------------
  // The CEO-hosted articles live at x.com/rynesaxe/status/… — not in `posts`,
  // so no anchor exists. Every amplifier of one shares that URL, so we group on
  // it and spend ONE call per group. Same link ⇒ same article, always.
  //
  // GUARD: a post cannot be amplifying an article that did not exist yet. The
  // model hedges at ~0.78 when it is really pattern-matching on shared Eco
  // vocabulary, which is just over the threshold, so four generic posts got
  // welded onto articles published 37-64 days LATER. Each one then bought its
  // article a phantom row on the wrong pillar's shelf, with its own stale
  // "last used" clock. Publication date is the cheap deterministic check that
  // kills the whole class. Only the content rung is guarded — the url/xurl/
  // anchor rungs are links, and a link cannot be coincidence.
  let claudeGroups = 0;
  let claudeCostUsd = 0;
  let prePublishRejected = 0;
  const byId = new Map(articles.map((a) => [a.id, a]));
  const postDatesBeforePublish = (p: AttributionPost, articleId: number): boolean => {
    const pub = byId.get(articleId)?.published_on;
    if (!pub || !p.created_at) return false;
    return new Date(p.created_at) < new Date(`${pub}T00:00:00Z`);
  };
  const claudeTemplates = opts.claudeTemplates ?? CLAUDE_MATCH_TEMPLATES;
  const remaining = posts.filter(
    (p) => !assign.has(p.id) && (!p.template || claudeTemplates.includes(p.template)),
  );
  if (remaining.length && opts.claudeMatch) {
    const groups = new Map<string, AttributionPost[]>();
    for (const p of remaining) {
      const statusLink = p.urls.map(anyStatusUrl).find(Boolean);
      const key = statusLink ?? `post:${p.id}`;
      const list = groups.get(key) ?? [];
      list.push(p);
      groups.set(key, list);
    }
    for (const [, group] of groups) {
      claudeGroups++;
      try {
        const hit = await opts.claudeMatch(group, articles);
        if (hit) {
          for (const p of group) {
            if (postDatesBeforePublish(p, hit.articleId)) {
              prePublishRejected++;
              continue;
            }
            assign.set(p.id, { ...hit, rung: "claude" });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(msg.slice(0, 200));
        // A bad key or an empty balance will fail identically for every
        // remaining group. Stop rather than burn N identical round-trips.
        if (/credit balance|401|invalid.*api.*key|ANTHROPIC_API_KEY/i.test(msg)) {
          errors.push(`aborted the content-match rung after a fatal API error (${groups.size - claudeGroups} groups unprocessed)`);
          break;
        }
      }
    }
  }

  // --- Write. --------------------------------------------------------------
  for (const [postId, a] of assign) {
    await sql`
      UPDATE posts
      SET article_id = ${a.articleId}, article_match = ${a.rung}, article_confidence = ${a.confidence},
          updated_at = now()
      WHERE id = ${postId} AND article_match IS DISTINCT FROM 'human'`;
    bump(a.rung);
  }

  return {
    scanned: posts.length,
    matched,
    unmatched: posts.length - assign.size,
    anchorsResolved,
    claudeGroups,
    claudeCostUsd,
    prePublishRejected,
    errors,
  };
}
