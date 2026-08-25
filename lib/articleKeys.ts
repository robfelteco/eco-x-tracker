// Pure article-identity helpers: which article does this URL / title refer to?
//
// Kept dependency-free (no db, no next) so lib/articles.ts, lib/ingest.ts AND the
// standalone seeding/backfill scripts can all import it — same rule as
// lib/dimensions.ts. Node's TS stripping can't resolve extensionless imports in
// scripts, so anything a script needs has to live in a leaf module like this.

// ---------------------------------------------------------------------------
// URL identity helpers
// ---------------------------------------------------------------------------

// https://eco.com/blog/<slug>/?utm=... -> "<slug>"  (utm params are stripped;
// Buffer appends them to about half our own links.)
export function ecoBlogSlug(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.toLowerCase().match(/eco\.com\/blog\/([a-z0-9-]+)/);
  return m ? m[1] : null;
}

// http://x.com/i/article/2041984281338376192 -> "2041984281338376192"
export function xArticleId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.toLowerCase().match(/(?:x|twitter)\.com\/i\/article\/(\d+)/);
  return m ? m[1] : null;
}

// https://x.com/eco/status/2046240619530444944 -> "2046240619530444944".
// Only @eco statuses: an amplifier that points at a partner's or the CEO's
// tweet is not pointing at an article WE published on this account.
export function ecoStatusId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.toLowerCase().match(/(?:x|twitter)\.com\/eco\/status\/(\d+)/);
  return m ? m[1] : null;
}

// Any x.com/twitter.com status, whoever the author is. Used to group the
// re-amplifications of a CEO-hosted article, which never appear in `posts`
// (we only ingest @eco) and so have no anchor row to join to.
export function anyStatusUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.toLowerCase().match(/(?:x|twitter)\.com\/([a-z0-9_]+)\/status\/(\d+)/);
  return m ? `x.com/${m[1]}/status/${m[2]}` : null;
}

// ---------------------------------------------------------------------------
// Title matching — the seeded PDF title vs. the title X put on the link card.
// They differ in small ways ("How Routes Enables…" vs "How Eco Routes Enables…",
// trailing spaces, curly vs straight apostrophes), so compare on tokens.
// ---------------------------------------------------------------------------

export function normTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9']+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Jaccard-ish overlap weighted toward the shorter title, so a strict subset
// ("how routes enables x" ⊂ "how eco routes enables x") scores high.
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(normTitle(a).split(" ").filter(Boolean));
  const tb = new Set(normTitle(b).split(" ").filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

export const TITLE_MATCH_THRESHOLD = 0.85;
