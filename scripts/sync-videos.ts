// Seed / refresh the video shelf: YouTube inventory, then the Dropbox manifest
// (file + transcripts + the team's "Weak (Don't Use)" verdict), then tag, then
// match clips to the X posts that already used them.
//
// Run: node --env-file=.env scripts/sync-videos.ts [--no-tags] [--no-match] [--force-tags]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncYouTubeVideos, ingestDropboxManifest, type DropboxVideoEntry } from "../lib/videos.ts";
import { tagVideos } from "../lib/videoTag.ts";
import { matchVideosToPosts, reconcileDropboxToYouTube } from "../lib/videoMatch.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const noTags = process.argv.includes("--no-tags");
const noMatch = process.argv.includes("--no-match");
const force = process.argv.includes("--force-tags");

const yt = await syncYouTubeVideos();
console.log(
  `youtube: ${yt.seen} uploads seen · ${yt.shorts} shorts · ${yt.inserted} new · ${yt.updated} updated`,
);
if (yt.errors.length) console.log(`  errors: ${yt.errors.slice(0, 3).join("; ")}`);

const manifest = JSON.parse(
  readFileSync(join(__dirname, "..", "db", "dropbox-shorts-manifest.json"), "utf8"),
) as {
  entries: (DropboxVideoEntry & { transcriptFileId?: string })[];
  transcripts: Record<string, string>;
};
const entries: DropboxVideoEntry[] = manifest.entries.map((e) => ({
  ...e,
  transcript: e.transcriptFileId ? (manifest.transcripts[e.transcriptFileId] ?? null) : null,
}));
const dbx = await ingestDropboxManifest(entries);
console.log(
  `dropbox: ${dbx.entries} files · ${dbx.mergedIntoYouTube} merged into a YouTube clip · ` +
    `${dbx.insertedNew} Dropbox-only · ${dbx.markedDoNotUse} marked do-not-use · ${dbx.transcripts} transcripts`,
);

const rec = await reconcileDropboxToYouTube();
console.log(
  `reconcile: ${rec.considered} Dropbox-only files considered · ${rec.merged} folded into a YouTube clip · ` +
    `${rec.leftStandalone} left standalone (file exists, not on the channel)`,
);
if (rec.errors.length) console.log(`  errors: ${rec.errors.slice(0, 3).join("; ")}`);

if (!noTags) {
  const tags = await tagVideos({ force });
  console.log(
    `tagging: ${tags.tagged} tagged · ${tags.skipped} skipped · ` +
      Object.entries(tags.bySeries).map(([s, n]) => `${n} ${s}`).join(", "),
  );
  if (tags.errors.length) console.log(`  errors: ${tags.errors.slice(0, 3).join("; ")}`);
}

if (!noMatch) {
  const m = await matchVideosToPosts();
  console.log(
    `matching: ${m.considered} posts considered · ${m.matched} matched to a clip · ` +
      `${m.unmatched} left unmatched · ${m.noCandidates} had no candidate in window`,
  );
  if (m.errors.length) console.log(`  errors: ${m.errors.slice(0, 3).join("; ")}`);
}
