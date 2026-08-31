# Anti-slop house standard

The master rulebook for every draft this tool generates. `lib/antiSlop.ts` is the
machine-readable version of this file: the prompt block handed to the model, plus
a deterministic linter that checks what comes back. Edit both together.

Compiled 2026-08-28 from three sources, plus what this account's own drafts kept
getting wrong:

1. **no-ai-slop** (petergyang, MIT) `github.com/petergyang/no-ai-slop`
   Editorial craft rules and a banned-pattern list. Strongest on the *why*.
2. **sloptells.com**
   Frequency-measured tells, each with a multiplier against human baseline, sorted
   by whether the tell is still active or already burned out. Strongest on *which*
   rules are worth spending attention on.
3. **The load-bearing vocabulary of Claude** (Louis Abraham)
   `louisabraham.github.io/load-bearing`. 461,121 GitHub pull requests, 51 million
   words, clustered by KL-divergence k-means. One cluster appeared in 2026 and
   accounts for 40% of human-attributed PRs. Strongest on *what is happening now*.

The three overlap, which is the useful part: a rule all three independently arrive
at is a rule to enforce hard. Where they disagree, the disagreement is recorded
below with the call we made.

---

## The one idea underneath all of it

Slop is writing that survives being moved. Take any sentence out of the draft and
drop it into a post about a different company, in a different market, on a
different day. If it still reads fine, it was carrying nothing, and it goes.

Everything below is a specific case of that test.

For this account the test has a second half. Eco's voice is precision-flavoured
and institutional, which is the *same register* the 2026 model cluster writes in.
Sounding smart is not evidence of being human here. The evidence is a number, a
named system, a dated fact, or a claim a reader could argue with.

---

## Tier 1: hard bans

Mechanical, checkable, no judgment call. The linter rejects these and fixes what
it can. A draft carrying one of these is not shipped.

### Form

**One post. Never a thread.** No `1/`, `2/`, `🧵`, `(1/5)`, `cont.`, "more below",
"a thread on", or a numbered run of paragraphs that reads as split posts. Long
form inside a single post is fine and often better. There is no character
constraint worth designing around, and the algorithm scores dwell, which a long
single post earns and a thread splits across five impressions.

**No em dashes.** Anywhere. Not as punctuation, not as a bullet marker, not in a
list. Use a comma, a colon, a full stop, or a plain hyphen.

Recorded disagreement: sloptells classifies the em dash as a *stale* tell, meaning
readers who flag it are pattern-matching on 2024. That is probably right as
detection. It is still a house ban, because the tell is now so widely believed
that being right about the statistics does not help when a reader bounces off the
post. The rule stands as a style rule, not a detection rule.

**No decorative markdown.** X renders none of it. `**bold**` ships as literal
asterisks. No `##` headers, no bold mid-sentence, no emoji used as bullets or
section markers. sloptells rates emoji-as-structure and headers-on-social-posts as
AI-only: no human writes them into a post.

**No bullets where two sentences work.** Bullets in conversational text run 13x
human baseline. A list is allowed when the content is a real list of parallel
items, never as a way to avoid writing a paragraph.

**No engagement bait.** No "curious what others think" (10x), no "thoughts?", no
"who else". Replies are worth 5.0 and are earned with a real claim, never asked
for. A report or mute costs -234 and -58.8, which no engagement gain covers.

### Words

Banned outright. These are dead on arrival:

> delve, foster, leverage, utilize, facilitate, empower, streamline, robust,
> cutting-edge, paradigm shift, game changer, this is huge, this changes
> everything, tapestry, realm, beacon, multifaceted, meticulous, intricate,
> paramount, transformative, elevate, embark, supercharge, harness, ever-evolving,
> unlock, seamless, no fluff, dive in

Banned phrases:

> it's worth noting, it's important to note, at the end of the day, when it comes
> to, at its core, in today's world, in the age of, in the world of, the reality
> is, the truth is, in terms of, going forward, let's dive in, that said,
> here's the thing, here's the kicker, thrilled to announce, excited to announce,
> humbled to announce

---

## Tier 2: the 2026 agent register

This is the tier the other two sources do not have yet, and it is the one that
matters most for Eco specifically.

Abraham's clustering found a vocabulary that did not exist in 2025 and now
dominates agent-written text. The top marker, `load-bearing`, runs **39.5x** the
corpus rate. The cluster is not the 2024 slop vocabulary. Nothing in it sounds
flowery. It sounds *rigorous*, which is exactly why it is dangerous for an
institutional voice: it reads as the register we are trying to write in.

Words from the cluster to treat as flags, weighted by how likely they are to show
up in market copy:

> load-bearing, genuinely, plainly, quietly, deliberately, merely, precisely,
> structurally, empirically, materially, outright, nobody, honest, honestly,
> asymmetry, premise, chokepoint, lever, seam, backstop, tripwire, machinery,
> spine, substrate, ratchet, floor, ceiling, teeth, wedge, latent, orthogonal,
> vacuous, indistinguishable, verbatim, survives, refuses, asserts, settles,
> carries, rests on, holds

Not one of these is a bad word. Several are good ones. The rule is a **budget**:
at most one per post, and only when it is doing work no plainer word does. Three
of them in one draft is the cluster, not a voice.

`genuinely` is the strongest single signal in the entire compiled set. sloptells
measures it at **51x** human baseline, and it is also near the top of Abraham's
2026 cluster. Two independent methods, same answer. Treat it as a hard ban.

**Self-inflicted case, found while compiling this.** The tracker's own prompt files
used `rather than` 19 times, `genuinely` 5 times, plus `deliberately`, `quietly`,
`plainly`, `merely`, `asymmetry`. Prompt style is imitated: the drafter was being
shown the exact register the rules told it to avoid. `lib/antiSlop.ts` now
sanitizes the assembled prompt before it is sent, and the authored instruction
strings were rewritten. Any new prompt text goes through the same check.

---

## Tier 3: construction patterns

Judgment calls. The linter flags them; a human clears them.

**Binary contrast.** "It's not X, it's Y." "The question isn't X, it's Y." "Not
because X. Because Y." State Y. All three sources list this, and sloptells puts it
at 5x baseline.

*Eco example.* "This isn't a bridge, it's a routing layer" becomes "Eco routes and
settles the whole flow atomically. A bridge moves one hop."

**The real question.** "The real question is", "the actual problem is", "what
actually matters is". 29x baseline, the highest-multiplier construct measured.
Cut the frame, keep the claim.

**Faux-insight setup.** "What nobody tells you", "the part everyone misses", "most
people get this wrong". These flatter the writer and delay the point. Make the
claim carry itself.

**Colon reveal.** A noun phrase, a colon, a lowercase dramatic reveal. "The detail
that makes it work: the solver fronts nothing." Write it as a sentence. Colons are
for lists, labels and quotes.

**Throat-clearing opener.** "Here's the thing", "Let me be clear", "I'll be
honest", "The uncomfortable truth is". Delete and start at the point.

**Superficial `-ing` analysis.** Trailing clauses that gesture at meaning without
adding any: "highlighting", "underscoring", "reflecting", "showcasing",
"signaling". Replace with the actual consequence. "Mastercard now settles in six
stablecoins, underscoring institutional adoption" becomes "Mastercard now settles
in six stablecoins. Its treasury desk holds none of them overnight."

**Importance puffery.** "Marks a pivotal moment", "stands as a testament",
"plays a vital role", "solidifies its position". State the fact. Let the reader
rank it.

**Weasel attribution.** "Experts agree", "studies show", "industry reports
suggest", "many argue". Name the institution or cut the claim. For curriculum
posts this is already a hard requirement: the source is named in the body and
linked.

**Interpretive metadiscourse.** "That matters more than it sounds", "the key point
is", "this distinction matters", "in other words". If the point is clear, delete.
If it is not, fix the point.

**Mic-drop closer.** The final short profound line. Delete it, do not improve it.
End on the last concrete sentence, a plain takeaway, or the open question. For
this account the open question is usually the strongest ending, because a reply is
worth 5.0 and an unresolved claim earns one honestly.

**Recap ending.** "In conclusion", "Ultimately", "Overall", or a closing paragraph
restating the post. The reader was just there.

**Negative listing.** "Not a bridge. Not a swap tool. A routing layer." Say the
last one.

**Dramatic fragmentation.** "X. And Y. And Z." "That's it. That's the post."

**Synonym cycling.** If "routing" is the right word, use it three times. Do not
rotate to "orchestration", "channelling", "directing" for variety. This one is
load-bearing for Eco in the other direction too: the vocabulary rotation is how
drafts accidentally adopt a category we refuse.

**Hedge pileup.** "It's probably fair to say this might be somewhat significant."
One hedge is honest. Three is a model covering itself.

---

## Tier 4: rhythm and shape

The hardest to check and the most reliable tell once you can see it.

**Sentences marching in formation.** Slop has a metronome. Every sentence lands in
the 12-to-18-word band, every paragraph runs three sentences, every section
resolves in the same shape. Human writing is lumpy. Put a four-word sentence next
to a thirty-word one because the argument needs it, not to perform variety.

**Suspiciously clean punctuation.** Perfectly balanced commas, no parentheses, no
sentence that starts with "And", no aside that runs long. Some roughness is
signal.

**Rule of three everywhere.** Two examples usually beat three. Three is the shape a
model reaches for when it has two examples and a rhythm to fill.

**Every paragraph ending on a punchy line.** Pick one place to land hard.

---

## Length policy

Threads are banned, so length is the only structural variable left, and the mix is
the point.

- **Tight, under 280 characters.** One number, one claim, one mechanism. The
  default for market news, chain integrations, quote cards and video copy, where
  something else carries the payload.
- **Mid, 400 to 900 characters.** A claim plus the mechanism under it plus a
  source. The workhorse for product posts and thought leadership.
- **Long form, 900 to 2000 characters.** Only when the material has
  steps: a mechanism that needs sequence, a curriculum parallel and its break, an
  argument with a real objection handled. Long form earns dwell, and dwell is the
  base quantity in the algorithm's scoring. It also fails hardest when the
  substance is not there, because a long thin post is the most punishable object
  on the platform.

When the tool returns three drafts, they span three different length bands. The
operator picks the one the moment calls for. That is what keeps the account from
drifting into all-short or all-long.

Length is never padded to reach a band. If the material only supports 200
characters, the draft is 200 characters and the other two options find more
material or a different angle.

---

## What is deliberately not banned

Over-correcting produces its own flatness, and each source warns about this.

- **"not just X"** runs 10x baseline but also shows up throughout good human
  writing. Soft flag, not a ban.
- **"in practice"**, **"especially"**, **signposting**: real writers use these.
  Flag on pileup only.
- **Contractions, fragments, an aside, a blunt opinion.** Keep them. The goal is
  writing that sounds like a specific person at a specific company on a specific
  day, not writing that has been sanded until nothing catches.
- **Repetition of the right word.** See synonym cycling above.
- **A long sentence that is clear.** Length is not the problem. Tangle is.

Retired, per sloptells, and no longer worth linting: `delve`, `tapestry`,
`a testament to`, staccato mic-drop stacks, "Great question!". They are kept in
the banned list because they cost nothing to keep, not because they are current
risks.

---

## The check, run before any draft is returned

1. Is it one post, with no thread markers?
2. Zero em dashes, zero markdown, zero structural emoji?
3. Zero banned words and phrases?
4. At most one Tier 2 register word, doing real work?
5. Would the opening line survive being moved to a competitor's account? If yes,
   it is filler.
6. Is there a number, a named system, or a dated fact in the first three lines?
7. Does the payload deliver what the first line implies? An overpromised hook is
   penalized directly by the click-dwell term.
8. Does it end on something concrete or open, not a kicker or a recap?
9. Read it aloud. Do the sentences vary, or do they march?
10. Would a treasury operator or a solver dev paste this into a work channel? That
    is the 20.0 signal, and it is the only score that matters.
