import { sql } from "../lib/db.ts";
import { runLaneWeb } from "../lib/quoteLanes.ts";

// Ingest the FULL TEXT of curriculum sources, so they can be drafted from.
//
// Migration 013 made text_doc_id the gate: a source we have not read is not
// draftable. The dry run showed 100 of 108 verified sources had never been
// ingested — the shelf was almost entirely metadata, which is why the drafter
// was filling the gap from its own priors and attributing the result to
// whichever piece was pinned.
//
// This covers everything Firecrawl can reach: article, report, primer,
// standard, regulation. Podcasts and videos are a different lane (Gemini
// transcription via scripts/sweep-channels.ts) and are reported, not attempted.
//
// Scraping is deduped by URL — several concepts legitimately cite the same
// piece, and they all point at one raw_documents row.
//
// Run:
//   npx tsx scripts/ingest-analog-sources.ts                # everything scrapable
//   npx tsx scripts/ingest-analog-sources.ts --limit 20     # a slice, to sample cost
//   npx tsx scripts/ingest-analog-sources.ts --analog nostro_vostro
//   npx tsx scripts/ingest-analog-sources.ts --dry-run      # list targets only

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const LIMIT = (() => {
  const i = args.indexOf("--limit");
  return i >= 0 ? Number(args[i + 1]) || Infinity : Infinity;
})();
const ONLY_ANALOG = (() => {
  const i = args.indexOf("--analog");
  return i >= 0 ? args[i + 1] : null;
})();

// The media lane cannot be scraped; runLaneWeb rejects these by design.
const MEDIA = /youtube\.com|youtu\.be|(^|\/\/)(x|twitter)\.com/i;

// Firecrawl's metadata.publishedTime is whatever the page put in a meta tag,
// which is not always a date Postgres accepts — one DTCC page returned
// "15/06/2026" and killed the run at source 55 of 63 with a DateTimeParseError.
// The date is incidental here (the piece's text is the point), so an
// unparseable one is dropped rather than allowed to end the ingest.
function safeDate(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  const year = new Date(t).getUTCFullYear();
  return year >= 1990 && year <= 2100 ? new Date(t).toISOString() : null;
}

function hashUrl(u: string): string {
  // Same shape quoteLanes uses for its web docs: a stable external_id per URL so
  // re-running is idempotent against the (source_kind, external_id) unique index.
  let h = 0;
  for (let i = 0; i < u.length; i++) h = (Math.imul(31, h) + u.charCodeAt(i)) | 0;
  return `web_${(h >>> 0).toString(36)}_${u.length}`;
}

interface Row {
  id: number;
  analog_id: string;
  title: string;
  url: string;
  kind: string | null;
}

(async () => {
  const rows = await sql<Row>`
    SELECT id, analog_id, title, url, kind
    FROM analog_sources
    WHERE verified = true AND text_doc_id IS NULL
      ${ONLY_ANALOG ? sql`AND analog_id = ${ONLY_ANALOG}` : sql``}
    ORDER BY analog_id, id
  `;

  const media = rows.filter((r) => MEDIA.test(r.url));
  const web = rows.filter((r) => !MEDIA.test(r.url));

  // One scrape per URL, then fan the resulting doc id back out to every source
  // row citing it.
  const byUrl = new Map<string, Row[]>();
  for (const r of web) byUrl.set(r.url, [...(byUrl.get(r.url) ?? []), r]);
  const targets = [...byUrl.keys()].slice(0, LIMIT).map((url) => ({ url, label: byUrl.get(url)![0].title }));

  console.log(
    `${rows.length} ungrounded source(s): ${web.length} scrapable across ${byUrl.size} unique URL(s), ` +
      `${media.length} media (needs transcription).`,
  );
  if (targets.length < byUrl.size) console.log(`--limit ${LIMIT}: attempting ${targets.length} of ${byUrl.size}.`);

  if (DRY) {
    for (const t of targets) console.log(`  would scrape  ${t.label.slice(0, 60)}\n                ${t.url}`);
    console.log(`\n[dry run] no requests made. Firecrawl scrape is 1 credit per page, so this run would cost ~${targets.length}.`);
    process.exit(0);
  }

  if (!targets.length) {
    console.log("Nothing scrapable left.");
  } else {
    const { docs, warnings } = await runLaneWeb(targets, async (done, total, label) => {
      if (done < total) console.log(`  [${done + 1}/${total}] ${String(label).slice(0, 66)}`);
    });

    let linked = 0;
    for (const d of docs) {
      const inserted = await sql<{ id: number }>`
        INSERT INTO raw_documents (source_kind, source_url, external_id, published_at, title, body, segments)
        VALUES ('article', ${d.sourceUrl}, ${hashUrl(d.sourceUrl)}, ${safeDate(d.publishedAt)}, ${d.title}, ${d.body}, NULL)
        ON CONFLICT (source_kind, external_id)
          -- Re-ingesting REPLACES the body: a source we scraped when the page
          -- was paywalled or half-rendered should improve on a later run, not
          -- be stuck with the first bad capture forever.
          DO UPDATE SET body = EXCLUDED.body, title = COALESCE(EXCLUDED.title, raw_documents.title),
                        fetched_at = now()
        RETURNING id`;
      const docId = Number(inserted[0].id);

      for (const r of byUrl.get(d.sourceUrl) ?? []) {
        await sql`UPDATE analog_sources SET text_doc_id = ${docId}, updated_at = now() WHERE id = ${r.id}`;
        linked++;
        console.log(`  grounded  [${r.analog_id}] ${r.title.slice(0, 58)} (${d.body.length.toLocaleString()} chars)`);
      }
    }

    console.log(`\nScraped ${docs.length}/${targets.length} page(s), grounded ${linked} source row(s).`);
    // Failures are printed rather than swallowed: a source that will not scrape
    // stays undraftable, and the operator needs to know which ones so they can
    // be replaced rather than silently missing from the shelf.
    if (warnings.length) {
      console.log(`\n${warnings.length} warning(s):`);
      for (const w of warnings) console.log(`  ${w}`);
    }
  }

  if (media.length) {
    console.log(`\n${media.length} media source(s) still need transcription (scripts/sweep-channels.ts):`);
    for (const r of media) console.log(`  #${r.id} [${r.analog_id}] ${r.title.slice(0, 58)}\n       ${r.url}`);
  }

  const [{ n, total }] = await sql<{ n: number; total: number }>`
    SELECT count(*) FILTER (WHERE text_doc_id IS NOT NULL)::int AS n, count(*)::int AS total
    FROM analog_sources WHERE verified = true
  `;
  console.log(`\nGrounded and draftable: ${n}/${total}`);
  process.exit(0);
})();
