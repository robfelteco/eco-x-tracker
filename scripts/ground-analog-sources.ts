import { sql } from "../lib/db.ts";

// Backfill for migration 013: point every curriculum source at the raw_documents
// row holding its full text, and report the ones we simply do not hold.
//
// Two passes, in order of cost:
//
//   1. LINK — a lot of this text is already in raw_documents, ingested by the
//      channel sweep or the article ingest, just never associated with the
//      analog_sources row that cites the same URL. Free, and it turned out to
//      cover the article/report side almost entirely.
//   2. REPORT — what is left is genuinely un-ingested. Those rows are now
//      undraftable by the gate in generateCopy.ts, which is the correct and
//      safe state, and this prints exactly what needs transcribing.
//
// Run:
//   npx tsx scripts/ground-analog-sources.ts            # link + report
//   npx tsx scripts/ground-analog-sources.ts --dry-run  # report only

const DRY = process.argv.includes("--dry-run");

/** youtube.com/watch?v=ID, youtu.be/ID, /embed/ID, /live/ID, /shorts/ID. */
function youtubeId(url: string): string | null {
  const m =
    url.match(/[?&]v=([A-Za-z0-9_-]{11})/) ??
    url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ??
    url.match(/\/(?:embed|live|shorts)\/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/** Trailing slash, utm noise and a leading www. are not identity. */
function canonical(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^utm_|^ref$|^source$/i.test(k)) u.searchParams.delete(k);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`.toLowerCase();
  } catch {
    return url.replace(/\/+$/, "").toLowerCase();
  }
}

interface SourceRow {
  id: number;
  analog_id: string;
  title: string;
  url: string;
  kind: string | null;
  facts_source: string | null;
  text_doc_id: number | null;
}

interface DocRow {
  id: number;
  source_kind: string;
  source_url: string;
  external_id: string | null;
  body_len: number;
}

(async () => {
  const sources = await sql<SourceRow>`
    SELECT id, analog_id, title, url, kind, facts_source, text_doc_id
    FROM analog_sources
    WHERE verified = true
    ORDER BY analog_id, id
  `;
  const docs = await sql<DocRow>`
    SELECT id, source_kind, source_url, external_id, length(body) AS body_len
    FROM raw_documents
    WHERE length(body) >= 400
  `;

  // Two indexes, because a YouTube source and its transcript almost never agree
  // on URL form (watch?v= vs youtu.be vs an added &t=).
  const byVideoId = new Map<string, DocRow>();
  const byUrl = new Map<string, DocRow>();
  for (const d of docs) {
    if (d.external_id) byVideoId.set(d.external_id, d);
    byUrl.set(canonical(d.source_url), d);
    const vid = youtubeId(d.source_url);
    if (vid) byVideoId.set(vid, d);
  }

  // channel_videos already tracks which raw_document a swept episode produced.
  // That is the most reliable link for the podcast shelf, so it wins.
  const chan = await sql<{ video_id: string; raw_document_id: number }>`
    SELECT video_id, raw_document_id FROM channel_videos WHERE raw_document_id IS NOT NULL
  `;
  const byChannelVideo = new Map(chan.map((c) => [c.video_id, Number(c.raw_document_id)]));

  let linked = 0;
  const ungrounded: SourceRow[] = [];

  for (const s of sources) {
    if (s.text_doc_id) continue;
    const vid = youtubeId(s.url);
    const docId =
      (vid && byChannelVideo.get(vid)) ??
      (vid && byVideoId.get(vid)?.id) ??
      byUrl.get(canonical(s.url))?.id ??
      null;

    if (!docId) {
      ungrounded.push(s);
      continue;
    }
    if (!DRY) {
      await sql`UPDATE analog_sources SET text_doc_id = ${docId}, updated_at = now() WHERE id = ${s.id}`;
    }
    linked++;
    console.log(`  linked  [${s.analog_id}] ${s.title.slice(0, 62)} -> doc ${docId}`);
  }

  console.log(`\n${DRY ? "[dry run] would link" : "linked"} ${linked} source(s) to existing text.\n`);

  if (ungrounded.length) {
    console.log(`UNGROUNDED — ${ungrounded.length} source(s) have no ingested text and are NOT draftable:\n`);
    const byKind = new Map<string, SourceRow[]>();
    for (const s of ungrounded) {
      const k = s.kind ?? "unknown";
      byKind.set(k, [...(byKind.get(k) ?? []), s]);
    }
    for (const [kind, rows] of [...byKind].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${kind} (${rows.length}):`);
      for (const s of rows) {
        const flag = s.facts_source === "description" ? "  [facts from DESCRIPTION — was drafting from a blurb]" : "";
        console.log(`    #${s.id} [${s.analog_id}] ${s.title.slice(0, 58)}${flag}`);
        console.log(`         ${s.url}`);
      }
    }
    console.log(
      `\nNext: transcribe the podcasts with scripts/sweep-channels.ts (it writes raw_documents and\n` +
        `channel_videos.raw_document_id), then re-run this script to link them.`,
    );
  } else {
    console.log("Every verified source is grounded.");
  }

  const [{ n }] = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM analog_sources WHERE verified = true AND text_doc_id IS NOT NULL
  `;
  console.log(`\nGrounded and draftable: ${n}/${sources.length}`);
  process.exit(0);
})();
