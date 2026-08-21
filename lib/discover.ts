// Discover — find recent external articles / reports / data the operator could
// turn into a BROAD-EDUCATIONAL @eco post. Emulates the carousel app's discover
// tool (Grok web_search + x_search, one call per editorial lens) but tuned for a
// single X post instead of a 12-slide carousel: we want fresh, sourced angles,
// not multi-beat "big topics". The broad-ed rule is "never reshare the same
// piece", so the route feeds Grok an exclude-list of what @eco has already
// posted and asks only for NEW territory.

const XAI_MODEL = "grok-4.3";

export interface DiscoverSource {
  title: string;
  url: string;
}

export interface DiscoveredItem {
  headline: string; // the angle / hook for an @eco broad-educational post
  summary: string; // 1-3 sentences the operator can build a post from
  keyStat?: string; // the single most quotable number, if any
  contentType: string; // suggested format: "article" | "data/chart" | "short video" | "thread"
  icp: string; // "institutional" | "developer"
  source: DiscoverSource;
}

const ECO_BRIEF = `Eco is a stablecoin infrastructure company — the neutral platform organizing the stablecoin market (issuers, liquidity managers, institutions orchestrate, clear, settle). Broad-educational posts are TOP-OF-FUNNEL: the market story carries the post and Eco's relevance rides in by implication — Eco is NOT named in the body. The reader should finish smarter about the stablecoin market.

Two ICPs (pick ONE per idea): "institutional" (finance/payments/treasury/tokenization leaders — tradfi-fluent: orchestration, clearing, settlement, primary/secondary markets) or "developer" (stablecoin infra builders).`;

const LENSES = [
  {
    id: "market-data",
    label: "Market data",
    brief:
      "Find a recent, verifiable stablecoin-market DATA point or trend (market cap milestone, volume crossover, growth curve, chain fragmentation, share shift) from data providers / research desks (DeFiLlama, Artemis, Visa Onchain Analytics, McKinsey, bank research). Each idea = one surprising number the ICP hasn't internalized yet.",
  },
  {
    id: "company-moves",
    label: "Company moves",
    brief:
      "Find a recent NAMED-company stablecoin move (a bank, card network, fintech, Fortune 500, asset manager issuing / settling / paying out in stablecoins) that signals where the market is going. Amplify the logo; never bash it.",
  },
  {
    id: "policy-infra",
    label: "Policy & infrastructure",
    brief:
      "Find a recent structural shift in rules or rails (GENIUS Act rollout, MiCA, state charters, new settlement rails/chains, custody approvals) and what it unlocks for institutions or developers.",
  },
];

function buildPrompt(lens: (typeof LENSES)[number], count: number, excludeTitles: string[]): string {
  const exclusion = excludeTitles.length
    ? `\nALREADY POSTED by @eco — do NOT propose these or near-duplicates (we never reshare the same piece). Find genuinely NEW territory:\n${excludeTitles.slice(0, 30).map((t) => `- ${t}`).join("\n")}\n`
    : "";
  return `${ECO_BRIEF}

YOUR LENS: ${lens.brief}
${exclusion}
Find the ${count} strongest, most RECENT ideas for a broad-educational @eco X post through this lens. Prefer developments from the last few weeks. Every idea must have a real, cited source (press release, article, dataset, filing) — no invented or rumored numbers. Chase the primary source over coverage of it.

Return ONLY a JSON object (no prose, no code fences) of this shape:
{"candidates":[{
  "headline":"the post angle / hook, one line",
  "summary":"1-3 sentences of the concrete facts + the so-what, only facts from the source",
  "keyStat":"the single most quotable number, short (e.g. \\"$138B\\") — omit if none",
  "contentType":"article" | "data/chart" | "short video" | "thread",
  "icp":"institutional" | "developer",
  "source":{"title":"outlet + piece, e.g. \\"Artemis, May 2026\\"","url":"https://real-source-url"}
}]}
Use only real URLs you actually found via search. Drop any idea whose stat you cannot verify against a real source.`;
}

function parseItems(text: string): DiscoveredItem[] {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) return [];
  try {
    const obj = JSON.parse(t.slice(start, end + 1));
    const list = Array.isArray(obj?.candidates) ? obj.candidates : [];
    return list
      .map((c: Record<string, unknown>) => {
        const src = (c.source ?? {}) as Record<string, unknown>;
        return {
          headline: String(c.headline ?? "").trim(),
          summary: String(c.summary ?? "").trim(),
          keyStat: c.keyStat ? String(c.keyStat).slice(0, 60) : undefined,
          contentType: ["article", "data/chart", "short video", "thread"].includes(c.contentType as string)
            ? String(c.contentType)
            : "article",
          icp: c.icp === "developer" ? "developer" : "institutional",
          source: { title: String(src.title || src.url || "").trim(), url: String(src.url ?? "").trim() },
        };
      })
      .filter((c: DiscoveredItem) => c.headline && c.summary && c.source.url);
  } catch {
    return [];
  }
}

async function grokLens(
  apiKey: string,
  lens: (typeof LENSES)[number],
  count: number,
  excludeTitles: string[],
): Promise<DiscoveredItem[]> {
  const res = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    signal: AbortSignal.timeout(200_000),
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: XAI_MODEL,
      stream: false,
      input: [{ role: "user", content: buildPrompt(lens, count, excludeTitles) }],
      tools: [{ type: "web_search" }, { type: "x_search" }],
    }),
  });
  if (!res.ok) throw new Error(`xAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const output: unknown[] = Array.isArray(data.output) ? data.output : [];
  const message = output.find(
    (o): o is { type?: string; content: { type: string; text?: string }[] } =>
      typeof o === "object" && o !== null && (o as { type?: string }).type === "message",
  );
  const block = message?.content?.find((c) => c.type === "output_text");
  return parseItems(block?.text ?? "").map((c) => ({ ...c })).slice(0, count);
}

export interface DiscoverResult {
  items: DiscoveredItem[];
  warnings: string[];
}

// Fan out across the lenses in parallel (a lens failing is non-fatal), then flat
// dedupe by headline. excludeTitles keeps it from resurfacing already-posted
// pieces (the broad-ed no-reshare rule).
export async function discover(excludeTitles: string[], perLens = 2): Promise<DiscoverResult> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("XAI_API_KEY is not set");
  const warnings: string[] = [];
  const settled = await Promise.allSettled(LENSES.map((l) => grokLens(apiKey, l, perLens, excludeTitles)));
  const pool: DiscoveredItem[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") pool.push(...r.value);
    else warnings.push(`${LENSES[i].label} lens failed: ${String(r.reason).slice(0, 120)}`);
  });
  // Dedupe by lowercased headline first words.
  const seen = new Set<string>();
  const items = pool.filter((c) => {
    const key = c.headline.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).slice(0, 6).join(" ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { items, warnings };
}
