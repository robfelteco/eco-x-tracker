import Anthropic from "@anthropic-ai/sdk";
import { sql } from "./db.ts";
import { icpPromptBlock, ICP_IDS, type DocTier } from "./icp.ts";
import { ECO_ONE_LINER } from "./positioning.ts";

// Tagging pass for the docs shelf: for each page, WHO is it for, is it postable
// at all, and what is the one thing worth building a post around.
//
// The tier is the load-bearing field. llms.txt indexes 73 pages and a good third
// of them are endpoint reference ("Get Intent Status Array", "Poll Gasless Job
// Status") that nobody will ever build a post around. Without a tier the shelf
// ranks those beside "Solutions for AI agents" and the operator has to re-make
// the same judgment every single time they open the card.
//
// Runs once per page and stores the verdict. Re-runs only for pages that are
// untagged or whose body has changed — a docs sync that adds three pages costs
// three calls, not seventy-three. Every verdict is overwritable by a human
// (tag_source 'human' is never touched again), so a bad call is one click to fix
// rather than a reason to distrust the column.

const MODEL = "claude-sonnet-4-6";
const BATCH = 8; // pages per call — enough context each, few enough to stay sharp

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
    _client = new Anthropic();
  }
  return _client;
}

function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

interface TagVerdict {
  id: number;
  icp: string | null;
  tier: DocTier;
  hook: string;
}

const SYSTEM = `
You are triaging pages of Eco's developer documentation (docs.eco.com) for use as source
material for @eco's X (Twitter) posts.

${ECO_ONE_LINER}

Its docs posts target two kinds of reader who might land there to self-serve an integration or to
work out what Eco offers: developers, and business/product decision makers at institutional scale.

For each page you are given a section, title, the docs team's own one-line description, and an
excerpt of the page body. Return three judgments per page.

1. icp — which single audience the page is genuinely FOR. Options:
${icpPromptBlock()}
   Use "builders" for concept, architecture and API pages written for a technical integrator
   generally rather than one named persona. Never guess wildly; "builders" is the honest default
   for technical pages.

2. tier — how postable the page is. This is the judgment that matters most; be strict.
   - "hero": a whole X post can be built around this page. It contains an ARGUMENT, a mechanism
     worth explaining, a named pain, a comparison, or a concrete capability. Someone scrolling
     past would stop for the idea on this page even if they never clicked.
   - "supporting": real substance, but it cannot carry a post alone. It works as the link under a
     broader take. Deep architecture pages, individual contract docs, quickstarts.
   - "reference": lookup material only — endpoint parameter tables, status-code lists, address
     registries, section landing pages that are just an index. There is no post here. Be willing
     to assign this to a third of the pages; a shelf full of false heroes is worse than a short one.

3. hook — ONE sentence, max 22 words, naming the specific thing on this page worth building a
   post around. Concrete, drawn from the actual page content, no marketing language. For a
   "reference" page write "No post here — lookup material."

Reply with ONLY a JSON array, one object per page, in the same order as the input:
[{"id": <number>, "icp": "<id>", "tier": "hero|supporting|reference", "hook": "<sentence>"}]
No prose, no code fences.
`.trim();

export interface TagResult {
  tagged: number;
  skipped: number;
  byTier: Record<string, number>;
  errors: string[];
}

// Tag every active page that has no tier yet. `force` re-tags everything except
// pages a human has ruled on.
export async function tagDocPages(opts: { force?: boolean } = {}): Promise<TagResult> {
  const res: TagResult = { tagged: 0, skipped: 0, byTier: {}, errors: [] };

  const pages = await sql<{
    id: number;
    section: string;
    title: string;
    blurb: string | null;
    body: string | null;
    icp: string | null;
  }>`
    SELECT id, section, title, blurb, body, icp
    FROM doc_pages
    WHERE active = true
      AND COALESCE(tag_source, '') <> 'human'
      AND (${!!opts.force} OR tier IS NULL)
    ORDER BY id`;

  for (let i = 0; i < pages.length; i += BATCH) {
    const batch = pages.slice(i, i + BATCH);
    const payload = batch.map((p) => ({
      id: p.id,
      section: p.section,
      title: p.title,
      docs_description: p.blurb,
      body_excerpt: (p.body ?? "").slice(0, 2400),
    }));

    try {
      const msg = await client().messages.create({
        model: MODEL,
        max_tokens: 1600,
        system: SYSTEM,
        messages: [{ role: "user", content: JSON.stringify(payload, null, 1) }],
      });
      const raw = msg.content.find((c) => c.type === "text");
      const parsed: TagVerdict[] = JSON.parse(stripFences(raw && "text" in raw ? raw.text : "[]"));

      let applied = 0;
      for (const v of parsed) {
        // bigint columns arrive from the neon HTTP driver as STRINGS, so a bare
        // `p.id === Number(v.id)` compares "5" to 5 and silently matches nothing.
        // Coerce both sides or every page falls through the `continue` below.
        const page = batch.find((p) => Number(p.id) === Number(v.id));
        if (!page) continue;
        applied++;
        const tier: DocTier = ["hero", "supporting", "reference"].includes(v.tier)
          ? v.tier
          : "supporting";
        // A path-derived ICP (from /solutions/<slug>) is ground truth — the URL
        // literally names the persona — so it wins over the model's guess.
        const icp = page.icp ?? (v.icp && ICP_IDS.includes(v.icp) ? v.icp : "builders");
        await sql`
          UPDATE doc_pages
          SET icp = ${icp}, tier = ${tier}, hook = ${(v.hook ?? "").slice(0, 400)},
              tagged_at = now(), tag_source = 'claude', updated_at = now()
          WHERE id = ${page.id}`;
        res.tagged++;
        res.byTier[tier] = (res.byTier[tier] ?? 0) + 1;
      }
      res.skipped += batch.length - applied;
    } catch (e) {
      res.errors.push(`batch ${i}-${i + batch.length}: ${e instanceof Error ? e.message : String(e)}`);
      res.skipped += batch.length;
    }
  }

  return res;
}
