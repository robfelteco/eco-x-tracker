# Broad Educational: from shelf to pipeline

Written 2026-10-16 after reading the lane's code (`lib/curriculum.ts`, `lib/angleBank.ts`,
`lib/discover.ts`, `lib/questions.ts`, `app/components/RecActions.tsx` discovery branch),
the live database, and the relaunched eco.com.

## 1. What the numbers say

**The 4-1-1 is inverted.** Last 60 days, main posts only:

| Bucket | Pillars | Posts | Share |
| --- | --- | --- | --- |
| Educational (the "4") | broad_educational 7, quote_card 7, thought_leadership 2 | 16 | 19% |
| Promo (the "1 + 1") | short-form video 21, product 20, DMV 18, dev doc 8, integration 2 | 69 | 81% |

Broad Educational alone is 7 of 85 (8%). At the account's ~10 posts/week, a real 4-1-1 needs
**6 to 7 educational posts a week**. The lane produced 11 in June, 6 in July, 6 in August, 4 in
September, 1 so far in October. The trend is the opposite of the strategy.

**The hand-worked step never happened.** `education_angles` has **zero rows**. The angle bank
shipped 2 Sep (Jay: "work the frames by hand first, let the tracker keep score") and six weeks
later nothing has been banked. That is not a discipline failure; the form is seven blank fields
with no inputs, sitting above two shelves that do not feed it.

**The curriculum machinery is big and barely used.** 20 concepts, 226 verified sources (108
ingested), question mining, six teaching shapes, per-source fan-out drafting with four grounding
gates. Three of 77 Broad Educational posts carry an `analog_id`. The lane is engineered for one
deep, verifiable mechanism post, and the ratio needs six light, well-chosen ones a week.

**What actually performs in this pillar** (median impressions, all time):

- link-card 1,107 · video 752 · photo 705. The external link in the body is the format.
- Top posts: WalletConnect report scenario (7.9k), "Why $32T in stablecoin volume still can't beat
  fintech" (5.7k), BNY + Circle (3.4k, 2.5k), Mastercard six stablecoins / eight chains (3.3k),
  Cash App + USDC (2.1k), "most stablecoin metrics measure supply" (1.6k).
- The shape that wins: a **named institution + one number + one line of so-what that implies Eco's
  thesis without naming Eco**. Pure mechanism explainers (nostro $27T, DTCC T+1) landed around the
  pillar median, not above it.

So the curriculum is a good *lens* on news (the Mastercard post is a fragmentation lesson; BNY is
a primary-market lesson) and a weak *destination* on its own.

## 2. What eco.com now says the audience is

The relaunch moved the vocabulary. The tracker's positioning brief (Aug 27) still describes "the
routing and execution layer"; the site now leads with:

- **"Failsafe"** / **all-or-nothing** execution ("every step confirms, or nothing executes")
- **"Program money movement"**, Sauce runtime (beta), guardrails enforced onchain
- **"Digital asset markets"** and **tokenized assets / RWAs**, explicitly "not just stablecoins"
- **"Stop pre-funding"**, just-in-time liquidity, PvP / RvP
- **1:1 stablecoin conversion at par**, signed verifiable quotes, gasless via Permit3
- **Agents** as a first-class audience (Skills, MCP server)

Six audiences, which should replace the lane's two-value ICP dropdown
(`institutional` / `developer`): **Agents, Asset Issuers, Onchain Builders, Payment & Treasury
Platforms, Trading Platforms, Wallet Platforms.**

Two things to flag to Ryne rather than resolve in the tool: the homepage uses "Move Money Smarter",
which `lib/positioning.ts` lists as a commodity phrase to avoid; and the thesis now rests on Sauce,
which is beta. Educational posts should imply the *property* (failsafe, no pre-funding,
programmable rules) and never the unshipped product.

Also: eco.com/support ("Stablepedia") is **1,273 explainer articles**. That is Eco's own map of
what the audience needs explained. The tracker does not know it exists. It is the best available
relevance rubric for "is this topic adjacent to what Eco is building".

## 3. Why the lane is hard to use today

Open the Broad Educational card and you get, top to bottom:

1. An empty angle bank with a "Bank an angle" button that opens a blank seven-field form.
2. "Lane 1 · Analog curriculum": four tier accordions, twenty concept rows, each with a source list
   (per-source Draft buttons, grounded / not ingested / file-link / vetted badges), a Breaks
   paragraph, Find sources, Mine questions, a six-way teaching-shape picker, and Draft all.
3. "Lane 2 · Market news": a what-worked table, then a "Discover fresh sources" button whose
   results are ephemeral (gone on reload, never stored, no dedupe against each other across runs).

The operator has to decide *which job they are doing* before they start, every surface branches
into four or five buttons, and nothing carries forward: a Discover result cannot be banked, a
banked angle cannot be drafted, a draft cannot be marked posted, and a posted post is not matched
back to any of them. Three tools, no path.

One concrete scoring bug makes it worse: `broad_educational.staleDays = 10` in `lib/taxonomy.ts`.
That tells the Prioritize board the pillar is healthy at one post per ten days, so the "4" of
4-1-1 almost never ranks at the top of "What should I post next". The board is enforcing the
inverted ratio.

## 4. The redesign: one pipeline, four states

Replace the three surfaces with a single queue. Every item is a **candidate** and moves
left to right:

```
INBOX  ->  PICKED  ->  DRAFTED  ->  POSTED
(stocked        (you chose it,   (3 bands,       (matched to the
 nightly)        bridge set)      copy ready)     @eco post at sync)
```

### Inbox: stocked for you, every morning

A nightly cron (`/api/edu-intake`, alongside the existing sweep and sync crons) fills an
`edu_candidates` table from feeds that already exist:

- The three Grok lenses in `lib/discover.ts` (market data, company moves, policy & rails), run
  nightly instead of on click, results persisted.
- The 156 `current`-tier analog sources the sweep already pulls in. Those are news items tagged to
  a mechanism; today they are buried under a concept row. They belong in the inbox with the
  concept as a tag.
- Podcast transcripts from the channel lane, as "clip-able claim" candidates.

At intake each candidate is:

- **Scraped** (Firecrawl, one credit) so grounding is automatic rather than a blocker.
- **Deduped** against `posts.link_resolved_url` and `posts.domains` (the no-reshare rule) and
  against prior candidates.
- **Tagged** with `analog_id` via `detectAnalog()` when a mechanism is in play.
- **Scored for adjacency**, 0 to 100, against a rubric built from eco.com: which of the six
  audiences it serves, which Eco theme it implies (fragmentation, pre-funding, all-or-nothing,
  programmable rules, tokenized assets, at-par conversion, agents), and whether a Stablepedia topic
  covers it. The score comes with one line of reasons, same contract as the pillar score.
- **Pre-framed**: the model writes the four angle-bank fields as a draft (frame, mechanism, Eco
  bridge, evidence). The operator edits or rejects; they do not start from blank.

The inbox shows ~10 to 15 cards a day, adjacency-ranked, each one line: headline · source ·
audience · theme · "bridge: ..." · Pick / Skip. Skipped candidates are remembered so they never
come back.

### Picked: the shortlist is the plan for the week

Picking is the human step Jay asked for, kept deliberately: you read the pre-filled frame and the
bridge, fix the bridge if it is wrong (it will be, often), set the audience. Thirty seconds, not
seven fields. The picked column is the week's educational queue and its length is checked against
the ratio meter (below).

### Drafted: one button, three bands

"Draft" on a picked candidate calls the existing `generateCopy` with `template =
broad_educational`, the scraped source text, the frame and bridge as the angle, and the
`analog_id` when present. The three-band contract (tight / mid / long) already returns; the
anti-slop and span checks stay. Teaching shapes stay available as an optional override, not a
required choice. Drafts persist on the candidate so a reload does not lose them.

### Posted: close the loop without typing

"Mark posted" moves the card; the next sync matches the new @eco post to the candidate by
`link_resolved_url` (the same join `lib/articleAttribution.ts` already does for Eco's own
articles) and attaches impressions. The curriculum coverage board, the "what worked" table and the
ratio meter all read from this. Nothing is re-entered.

### The 4-1-1 meter, at the top of Prioritize

A week strip above the pillar list:

```
This week   edu 2 · soft 4 · hard 3      4-1-1 needs 5 more educational
```

with the bucket mapping declared in `lib/taxonomy.ts` (proposed: **edu** = broad_educational,
quote_card, DMV market-wide; **soft** = thought_leadership, short-form video, dev doc, DMV
integrated-chain; **hard** = product_post, integration_announcement). The pillar scorer then
takes the ratio deficit as an input, so Broad Educational ranks first whenever the week is short,
which under 4-1-1 is most weeks.

### What the curriculum becomes

Not a lane. A **filter and a tag**. The inbox has a "mechanisms never taught" chip that filters to
candidates carrying an untaught `analog_id`; the concept's parallel / break / guardrail ride along
into the drafter as they do today. Question mining moves to a button on a candidate ("what do
people ask about this?") rather than on a concept. The four-tier accordion, the per-source fan-out
and the shape picker come off the card.

## 5. Build order

**Phase 1, the fix that changes the board today (small).**
`staleDays` for broad_educational to 2; the ratio meter and bucket mapping; six-audience ICP list
replacing the two-value dropdown. No new tables.

**Phase 2, the inbox (the real work).**
`edu_candidates` table and migration; nightly intake cron that persists Grok lenses + current-tier
sources, scrapes, dedupes, tags, adjacency-scores and pre-frames; the four-column card UI
replacing the current discovery branch of `RecActions.tsx`; Draft wired to `generateCopy`; Mark
posted. The angle bank's rows become the Picked column (migrate the empty table, keep the fields).

**Phase 3, closing the loop.**
Sync-time matching of posts to candidates by resolved URL; coverage and what-worked read from it;
skip memory feeding the Grok exclude list; Stablepedia topic index pulled once and refreshed
weekly as the adjacency rubric's vocabulary.

Out of scope on purpose: automating the pick. The operator chooses; the tool makes the choice a
thirty-second read instead of a research project.

## 6. Open questions for Rob / Jay / Ryne

1. Bucket mapping for 4-1-1: are quote cards "educational" (external voice) or "soft" (Eco event)?
2. Does the 4 have to be Eco-unnamed, as the pillar definition says, or can an educational post
   name Eco in a last line? The top performers never do; the website's new vocabulary makes
   implying it easier.
3. "Move Money Smarter" on the homepage versus the commodity-phrase rule in the brief.
4. Agents as an educational audience: the site treats them as first-class; the lane has never
   produced a post for them.
