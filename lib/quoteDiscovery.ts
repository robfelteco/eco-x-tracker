import { sql } from "./db.ts";
import { getRoster, getWatchSources, type RosterPerson } from "./quoteRoster.ts";
import {
  runLaneX, runLaneYouTube, runLaneWeb, listChannelUploads, mapReportHub, sweepForRosterNames,
  webDeepLink, youtubeDeepLink, type LaneDoc,
} from "./quoteLanes.ts";
import { extractQuotes } from "./quoteExtract.ts";
import { verifyQuote, surroundingContext, quoteHash } from "./quoteVerify.ts";
import { scoreCandidate } from "./quoteScore.ts";
import { LANES, DEFAULT_LANE_MS, RUN_STALE_MS, type Lane, type RunProgress } from "./quoteProgress.ts";

// The discovery orchestrator (spec §3).
//
// A run is a row; each LANE is processed by its own invocation. The button
// enqueues the run and returns immediately, and the client polls status while
// lanes complete one at a time. That is deliberate rather than a compromise: a
// Gemini pass over a 90-minute podcast takes minutes, and a serverless function
// duration limit would kill a monolithic run. Splitting per lane also means
// partial results are real — a reviewer can work the X lane while YouTube is
// still transcribing.

export { LANES };
export type { Lane };

export interface RunRow {
  id: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  lookbackDays: number;
  budgetCents: number;
  spendCents: number;
  laneStatus: Record<string, string>;
  stats: Record<string, unknown>;
  progress: RunProgress | null;
  errors: string[];
}

// A run can spend real money (X bills per post read), and this app has no auth
// yet, so an accidental double-click or a stuck client must not be able to start
// a second paid run alongside the first. A run still moving is reused rather
// than duplicated; one older than this is treated as abandoned. Shared with the
// panel so the two can't disagree about which runs are still alive.
const RUN_STALE_MINUTES = RUN_STALE_MS / 60_000;

export class RunInProgressError extends Error {
  // Declared explicitly rather than as a constructor parameter property: Node's
  // strip-only TypeScript mode (which every script in scripts/ runs under)
  // rejects parameter properties, even though the Next build compiles them.
  readonly runId: number;
  constructor(runId: number) {
    super(`discovery run ${runId} is already in progress`);
    this.name = "RunInProgressError";
    this.runId = runId;
  }
}

export async function createRun(opts: {
  triggeredBy: string;
  lookbackDays?: number;
  budgetCents?: number;
}): Promise<number> {
  const live = await sql<{ id: number }>`
    SELECT id FROM discovery_runs
    WHERE status = 'running'
      AND started_at > now() - (${RUN_STALE_MINUTES} || ' minutes')::interval
    ORDER BY started_at DESC LIMIT 1`;
  if (live.length) throw new RunInProgressError(Number(live[0].id));

  // Anything older is abandoned — mark it so it stops blocking, and so the UI
  // never shows a run that has been "running" for a day.
  await sql`
    UPDATE discovery_runs SET status = 'partial', finished_at = now()
    WHERE status = 'running' AND started_at <= now() - (${RUN_STALE_MINUTES} || ' minutes')::interval`;

  const lanes = Object.fromEntries(LANES.map((l) => [l, "queued"]));
  // progress defaults to '{}' — a new run must not inherit the last one's step.
  const rows = await sql<{ id: number }>`
    INSERT INTO discovery_runs (triggered_by, lookback_days, budget_cents, status, lane_status)
    VALUES (${opts.triggeredBy}, ${opts.lookbackDays ?? 365}, ${opts.budgetCents ?? 500}, 'running', ${JSON.stringify(lanes)}::jsonb)
    RETURNING id`;
  return Number(rows[0].id);
}

export async function getRun(id: number): Promise<RunRow | null> {
  const rows = await sql<RunRow>`
    SELECT id, status, started_at AS "startedAt", finished_at AS "finishedAt",
           lookback_days AS "lookbackDays", budget_cents AS "budgetCents",
           spend_cents AS "spendCents", lane_status AS "laneStatus", stats, progress, errors
    FROM discovery_runs WHERE id = ${id}`;
  if (!rows.length) return null;
  return { ...rows[0], id: Number(rows[0].id) };
}

export async function latestRun(): Promise<RunRow | null> {
  const rows = await sql<{ id: number }>`SELECT id FROM discovery_runs ORDER BY started_at DESC LIMIT 1`;
  return rows.length ? getRun(Number(rows[0].id)) : null;
}

async function patchRun(
  id: number,
  patch: { lane?: Lane; laneStatus?: string; addSpendCents?: number; stats?: Record<string, unknown>; errors?: string[] },
): Promise<void> {
  if (patch.lane && patch.laneStatus) {
    await sql`
      UPDATE discovery_runs
      SET lane_status = lane_status || ${JSON.stringify({ [patch.lane]: patch.laneStatus })}::jsonb
      WHERE id = ${id}`;
  }
  if (patch.addSpendCents) {
    await sql`UPDATE discovery_runs SET spend_cents = spend_cents + ${patch.addSpendCents} WHERE id = ${id}`;
  }
  if (patch.stats) {
    await sql`UPDATE discovery_runs SET stats = stats || ${JSON.stringify(patch.stats)}::jsonb WHERE id = ${id}`;
  }
  if (patch.errors?.length) {
    await sql`UPDATE discovery_runs SET errors = errors || ${JSON.stringify(patch.errors)}::jsonb WHERE id = ${id}`;
  }
  // A run is complete once no lane is queued or running; 'partial' if any lane
  // stopped short, so the UI never implies coverage it didn't get.
  const rows = await sql<{ laneStatus: Record<string, string> }>`
    SELECT lane_status AS "laneStatus" FROM discovery_runs WHERE id = ${id}`;
  const st = rows[0]?.laneStatus ?? {};
  const values = Object.values(st);
  if (values.length && !values.some((v) => v === "queued" || v === "running")) {
    const status = values.some((v) => v === "partial" || v === "failed") ? "partial" : "complete";
    await sql`UPDATE discovery_runs SET status = ${status}, finished_at = now() WHERE id = ${id}`;
  }
}

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

// A lane is one long HTTP request, so the only way the browser can learn what
// is happening inside it is for the lane to write it down. Each report is a
// whole-column overwrite rather than a merge: there is exactly one thing a run
// is doing at any moment, and a merge would leave the previous step's `done`
// and `note` behind to be read as current.
function makeReporter(runId: number, lane: Lane, laneStartedAt: string) {
  let lastWrite = 0;
  let lastStep = "";
  return async (step: string, done?: number, total?: number, note?: string): Promise<void> => {
    const now = Date.now();
    // Throttle within a step — a 40-person roster shouldn't mean 40 writes a
    // second — but never drop a step transition, which is the one the reviewer
    // is actually waiting to see.
    if (step === lastStep && now - lastWrite < 1000) return;
    lastWrite = now;
    lastStep = step;
    const p: RunProgress = { lane, step, done, total, note: note?.slice(0, 120), at: new Date().toISOString(), laneStartedAt };
    try {
      await sql`UPDATE discovery_runs SET progress = ${JSON.stringify(p)}::jsonb WHERE id = ${runId}`;
    } catch {
      // Progress is a nicety. A run must never die because it couldn't say so.
    }
  };
}

// Per-lane duration learned from history, so the estimate on screen is this
// roster's actual pace rather than a guess baked in at build time. Median, not
// mean: one 8-minute YouTube lane shouldn't move every future estimate.
export async function laneEtaMs(): Promise<Record<Lane, number>> {
  const out = { ...DEFAULT_LANE_MS };
  try {
    const rows = await sql<{ stats: Record<string, { ms?: number }> }>`
      SELECT stats FROM discovery_runs
      WHERE status IN ('complete', 'partial')
      ORDER BY started_at DESC LIMIT 8`;
    for (const l of LANES) {
      const xs = rows
        .map((r) => Number(r.stats?.[l]?.ms))
        .filter((n) => Number.isFinite(n) && n > 1000)
        .sort((a, b) => a - b);
      if (xs.length) out[l] = Math.round(xs[Math.floor(xs.length / 2)]);
    }
  } catch {
    /* fall back to the defaults */
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lane execution
// ---------------------------------------------------------------------------

export interface LaneOutcome {
  lane: Lane;
  docs: number;
  candidates: number;
  verifyFailed: number;
  spendCents: number;
  warnings: string[];
}

export async function runLane(runId: number, lane: Lane): Promise<LaneOutcome> {
  const run = await getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  await patchRun(runId, { lane, laneStatus: "running" });

  const laneStart = Date.now();
  const report = makeReporter(runId, lane, new Date(laneStart).toISOString());

  const roster = await getRoster();
  const byName = new Map(roster.map((p) => [p.fullName.toLowerCase(), p]));
  const competitorNames = (
    await sql<{ name: string }>`SELECT name FROM orgs WHERE is_competitor = true`
  ).map((r) => r.name);

  let docs: LaneDoc[] = [];
  let spendCents = 0;
  const warnings: string[] = [];
  let partial = false;
  let laneFailed = false;

  try {
    if (lane === "x") {
      // Reserve a slice of the budget for the roster-discovery sweep so the
      // roster can still grow when the timelines eat the rest.
      const sweepBudget = Math.min(50, Math.floor(run.budgetCents * 0.1));
      await report("timelines", 0, roster.filter((p) => p.xHandle).length);
      const res = await runLaneX(roster, {
        lookbackDays: run.lookbackDays,
        budgetCents: run.budgetCents - sweepBudget,
        onProgress: (done, total, note) => report("timelines", done, total, note),
      });
      docs = res.docs;
      spendCents += res.spendCents;
      warnings.push(...res.warnings);
      partial = res.partial;

      const queries = (await getWatchSources("x_search")).map((w) => w.identifier);
      if (queries.length && !partial) {
        const known = new Set(roster.map((p) => (p.xHandle ?? "").toLowerCase()).filter(Boolean));
        const sweep = await sweepForRosterNames(queries, known, sweepBudget, (done, total, note) =>
          report("sweep", done, total, note),
        );
        spendCents += sweep.spendCents;
        warnings.push(...sweep.warnings);
        await patchRun(runId, { stats: { rosterSuggestions: sweep.found } });
      }
    } else if (lane === "youtube") {
      const sinceIso = new Date(Date.now() - run.lookbackDays * 86_400_000).toISOString();
      const channels = [
        ...(await getWatchSources("yt_channel")).map((w) => w.identifier),
        ...roster.map((p) => p.ytChannel).filter((c): c is string => !!c),
      ];
      const videos: Awaited<ReturnType<typeof listChannelUploads>> = [];
      let listed = 0;
      for (const c of channels) {
        await report("list", listed++, channels.length, c);
        try {
          videos.push(...(await listChannelUploads(c, sinceIso, 3)));
        } catch (err) {
          warnings.push(`channel ${c}: ${(err instanceof Error ? err.message : String(err)).slice(0, 140)}`);
          if (/YOUTUBE_API_KEY/i.test(String(err))) break;
        }
      }
      // Shorts are never a panel or an interview, and a 3-hour stream would eat
      // the whole run. Filter before paying Gemini for a single token.
      const usable = videos
        .filter((v) => v.durationSec == null || (v.durationSec >= 240 && v.durationSec <= 7200))
        .slice(0, 12);
      const skipped = videos.length - usable.length;
      if (skipped > 0) warnings.push(`skipped ${skipped} video(s) outside the 4min-2hr window (Shorts / very long streams)`);
      await report("transcribe", 0, usable.length);
      const res = await runLaneYouTube(usable, (done, total, note) => report("transcribe", done, total, note));
      docs = res.docs;
      warnings.push(...res.warnings);
      partial = res.partial;
      laneFailed = !!res.failed;
    } else {
      // A watch_source of kind report_site is a HUB, not an article. Map it to
      // the pieces underneath, then scrape those — scraping the hub returns
      // navigation and teasers, which contain no quotable sentence.
      const sites = await getWatchSources("report_site");
      const targets: { url: string; label?: string }[] = [];
      let mapped = 0;
      for (const s of sites) {
        await report("map", mapped++, sites.length, s.label);
        const hub = `https://${s.identifier}`;
        try {
          const found = await mapReportHub(hub, 5);
          if (found.length) targets.push(...found.map((u) => ({ url: u, label: s.label })));
          else warnings.push(`${s.label}: hub mapped to no article pages`);
        } catch (err) {
          warnings.push(`${s.label}: map failed — ${(err instanceof Error ? err.message : String(err)).slice(0, 140)}`);
        }
      }
      const scrapeTargets = targets.slice(0, 20);
      await report("scrape", 0, scrapeTargets.length);
      const res = await runLaneWeb(scrapeTargets, (done, total, note) => report("scrape", done, total, note));
      docs = res.docs;
      warnings.push(...res.warnings);
      partial = res.partial;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await patchRun(runId, { lane, laneStatus: "failed", errors: [`${lane}: ${msg.slice(0, 300)}`] });
    return { lane, docs: 0, candidates: 0, verifyFailed: 0, spendCents, warnings: [...warnings, msg] };
  }

  // Persist every document BEFORE extraction. Verification reads from here, and
  // it stops us re-paying for the same source on the next run.
  let candidates = 0;
  let verifyFailed = 0;

  // Cap how many candidates any ONE speaker can contribute to a run. Spreading
  // the FETCH across the roster wasn't enough on its own: a prolific
  // thread-poster still produced 16 of 38 queue items, because extraction pulls
  // up to 5 per source and they had many sources. A reviewer wants a queue they
  // can compare across, not one executive's timeline.
  const MAX_PER_SPEAKER = 3;
  const perSpeaker = new Map<string, number>();

  await report("extract", 0, docs.length);
  let extracted = 0;
  for (const d of docs) {
    await report("extract", extracted++, docs.length, d.title ?? d.sourceUrl);
    const docRows = await sql<{ id: number }>`
      INSERT INTO raw_documents (run_id, source_kind, source_url, external_id, published_at, title, body, segments)
      VALUES (${runId}, ${d.sourceKind}, ${d.sourceUrl}, ${d.externalId},
              ${d.publishedAt}, ${d.title}, ${d.body}, ${d.segments ? JSON.stringify(d.segments) : null}::jsonb)
      ON CONFLICT (source_kind, external_id) DO UPDATE SET run_id = EXCLUDED.run_id
      RETURNING id`;
    const docId = Number(docRows[0].id);

    try {
      const raw = await extractQuotes(d.body, {
        title: d.title,
        sourceKind: d.sourceKind,
        knownSpeakers: d.knownSpeakers,
      });
      for (const c of raw) {
        if (!c.speaker_name) continue; // never queue an unattributed quote

        const speakerKey = c.speaker_name.toLowerCase();
        if ((perSpeaker.get(speakerKey) ?? 0) >= MAX_PER_SPEAKER) continue;

        // --- The gate. Nothing past here without a verbatim match. ---
        const v = verifyQuote(c.quote_text, d.body);
        if (v.verification === "failed") {
          verifyFailed++;
          continue;
        }

        const person = byName.get(c.speaker_name.toLowerCase()) ?? null;
        const ctx = surroundingContext(c.quote_text, d.body);
        const deepLink =
          d.sourceKind === "youtube"
            ? youtubeDeepLink(d.sourceUrl, c.start_sec)
            : d.sourceKind === "x_post"
              ? d.sourceUrl
              : webDeepLink(d.sourceUrl, c.quote_text);

        // Resolve the org even when the SPEAKER isn't on the roster. Credibility
        // still caps at the unrostered floor (spec §10), but the reviewer sees a
        // real tier badge instead of "unrostered", which is what makes the
        // "add speaker to roster" action worth taking.
        const org = person?.orgId
          ? { id: person.orgId, tier: person.orgTier }
          : await lookupOrgByName(c.org_as_stated);
        const orgTier = org?.tier ?? null;
        const scored = scoreCandidate({
          person,
          orgTier,
          isCompetitor: person?.isCompetitor ?? false,
          saidAt: d.publishedAt,
          lookbackDays: run.lookbackDays,
          wordCount: c.quote_text.trim().split(/\s+/).length,
          selfContained: c.self_contained,
          singleClaim: c.single_claim,
          pillarTag: c.pillar_tag,
          verification: v.verification,
          quoteText: c.quote_text,
          competitorNames,
        });

        // ON CONFLICT DO NOTHING against the quote_hash unique index: a quote
        // already reviewed — approved OR rejected — never resurfaces.
        const ins = await sql<{ id: number }>`
          INSERT INTO quote_candidates (
            run_id, raw_document_id, quote_text, quote_hash, speaker_name, speaker_title,
            org_name, person_id, org_id, said_at, deep_link, context_before, context_after,
            topic_tags, verification, score, score_breakdown, pillar_tag, disqualifiers
          ) VALUES (
            ${runId}, ${docId}, ${c.quote_text}, ${quoteHash(c.quote_text)}, ${c.speaker_name},
            ${c.speaker_title_as_stated ?? person?.title ?? null},
            ${c.org_as_stated ?? person?.orgName ?? null}, ${person?.id ?? null}, ${org?.id ?? null},
            ${d.publishedAt}, ${deepLink}, ${ctx.before || c.context_before}, ${ctx.after || c.context_after},
            ${c.topic_tags}, ${v.verification}, ${scored.score},
            ${JSON.stringify(scored.breakdown)}::jsonb, ${c.pillar_tag}, ${scored.disqualifiers}
          )
          ON CONFLICT (quote_hash) DO NOTHING
          RETURNING id`;
        if (ins.length) {
          candidates++;
          perSpeaker.set(speakerKey, (perSpeaker.get(speakerKey) ?? 0) + 1);
        }
      }
    } catch (err) {
      warnings.push(`extract ${d.sourceUrl}: ${(err instanceof Error ? err.message : String(err)).slice(0, 140)}`);
    }
  }

  await patchRun(runId, {
    lane,
    laneStatus: laneFailed ? "failed" : partial ? "partial" : "complete",
    addSpendCents: spendCents,
    stats: { [lane]: { docs: docs.length, candidates, verifyFailed, ms: Date.now() - laneStart } },
    errors: warnings.slice(0, 20),
  });

  return { lane, docs: docs.length, candidates, verifyFailed, spendCents, warnings };
}

// Match an org stated in the source against the ones we track. Exact name first,
// then a loose containment pass so "Visa Inc." / "Visa Crypto" still land on Visa.
async function lookupOrgByName(name: string | null): Promise<{ id: number; tier: number } | null> {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  const exact = await sql<{ id: number; org_tier: number }>`
    SELECT id, org_tier FROM orgs WHERE lower(name) = ${n} LIMIT 1`;
  if (exact.length) return { id: Number(exact[0].id), tier: exact[0].org_tier };
  const loose = await sql<{ id: number; org_tier: number }>`
    SELECT id, org_tier FROM orgs
    WHERE ${n} LIKE '%' || lower(name) || '%'
    ORDER BY length(name) DESC LIMIT 1`;
  return loose.length ? { id: Number(loose[0].id), tier: loose[0].org_tier } : null;
}

// ---------------------------------------------------------------------------
// Review queue reads + actions (spec §11)
// ---------------------------------------------------------------------------

export interface QuoteCandidate {
  id: number;
  quoteText: string;
  speakerName: string;
  speakerTitle: string | null;
  orgName: string | null;
  orgTier: number | null;
  handlesVerifiedAt: string | null;
  saidAt: string | null;
  deepLink: string;
  contextBefore: string | null;
  contextAfter: string | null;
  topicTags: string[];
  verification: string;
  score: number | null;
  scoreBreakdown: Record<string, number> | null;
  pillarTag: string | null;
  disqualifiers: string[];
  status: string;
  sourceKind: string;
  sourceTitle: string | null;
}

export async function getQueue(limit = 50, status = "candidate"): Promise<QuoteCandidate[]> {
  const rows = await sql<QuoteCandidate>`
    SELECT q.id, q.quote_text AS "quoteText", q.speaker_name AS "speakerName",
           q.speaker_title AS "speakerTitle", q.org_name AS "orgName",
           o.org_tier AS "orgTier", p.handles_verified_at AS "handlesVerifiedAt",
           q.said_at AS "saidAt", q.deep_link AS "deepLink",
           q.context_before AS "contextBefore", q.context_after AS "contextAfter",
           q.topic_tags AS "topicTags", q.verification, q.score,
           q.score_breakdown AS "scoreBreakdown", q.pillar_tag AS "pillarTag",
           q.disqualifiers, q.status,
           d.source_kind AS "sourceKind", d.title AS "sourceTitle"
    FROM quote_candidates q
    LEFT JOIN orgs o ON o.id = q.org_id
    LEFT JOIN people p ON p.id = q.person_id
    LEFT JOIN raw_documents d ON d.id = q.raw_document_id
    WHERE q.status = ${status}
    ORDER BY q.score DESC NULLS LAST, q.created_at DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

export async function reviewCandidate(
  id: number,
  action: "approve" | "reject",
  by: string,
  rejectReason?: string,
): Promise<boolean> {
  const rows = await sql<{ id: number }>`
    UPDATE quote_candidates
    SET status = ${action === "approve" ? "approved" : "rejected"},
        reviewed_by = ${by}, reviewed_at = now(),
        reject_reason = ${action === "reject" ? (rejectReason ?? null) : null}
    WHERE id = ${id} AND status = 'candidate'
    RETURNING id`;
  return rows.length > 0;
}

export async function queueCounts(): Promise<{ candidate: number; approved: number; rejected: number }> {
  const rows = await sql<{ status: string; n: number }>`
    SELECT status, COUNT(*)::int AS n FROM quote_candidates GROUP BY status`;
  const out = { candidate: 0, approved: 0, rejected: 0 };
  for (const r of rows) if (r.status in out) out[r.status as keyof typeof out] = r.n;
  return out;
}

export async function getRosterSuggestions(limit = 20) {
  return sql<{
    id: number; xHandle: string; displayName: string | null; bio: string | null;
    followers: number | null; seenCount: number; sampleUrl: string | null;
  }>`
    SELECT id, x_handle AS "xHandle", display_name AS "displayName", bio,
           followers, seen_count AS "seenCount", sample_url AS "sampleUrl"
    FROM roster_suggestions WHERE status = 'new'
    ORDER BY seen_count DESC, followers DESC NULLS LAST
    LIMIT ${limit}`;
}

// Promote a discovered name onto the roster. Org is matched by name where we
// already track it; otherwise the person lands org-less and their credibility
// stays capped until someone files them (spec §10).
export async function addSuggestionToRoster(
  id: number,
  input: { fullName: string; title: string; orgName?: string | null; seniority: number },
): Promise<boolean> {
  const rows = await sql<{ xHandle: string; xAuthorId: string | null }>`
    SELECT x_handle AS "xHandle", x_author_id AS "xAuthorId" FROM roster_suggestions WHERE id = ${id}`;
  if (!rows.length) return false;
  const orgRows = input.orgName
    ? await sql<{ id: number }>`SELECT id FROM orgs WHERE lower(name) = ${input.orgName.toLowerCase()} LIMIT 1`
    : [];
  // The x_handle uniqueness index is partial, so ON CONFLICT can't infer it —
  // check, then insert.
  const dupe = await sql<{ id: number }>`
    SELECT id FROM people WHERE lower(x_handle) = ${rows[0].xHandle.toLowerCase()} LIMIT 1`;
  if (!dupe.length) {
    await sql`
      INSERT INTO people (full_name, title, org_id, seniority, x_handle, x_author_id)
      VALUES (${input.fullName}, ${input.title}, ${orgRows[0]?.id ?? null}, ${input.seniority},
              ${rows[0].xHandle}, ${rows[0].xAuthorId})`;
  }
  await sql`UPDATE roster_suggestions SET status = 'added' WHERE id = ${id}`;
  return true;
}

export async function ignoreSuggestion(id: number): Promise<void> {
  await sql`UPDATE roster_suggestions SET status = 'ignored' WHERE id = ${id}`;
}

export type { RosterPerson };
