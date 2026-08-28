import type { Template } from "./taxonomy.ts";

// How a post should be BUILT, per pillar.
//
// The positioning brief says who we are and what the ranking signals reward.
// That is not enough to write from: "earn copy-link shares" means something
// different for a 12-second data animation than for a five-post explainer of
// correspondent banking. This file is the missing layer, and it is derived from
// two things only:
//
//   1. The August 2026 algorithm facts and the x-algo-optimizer skill's format
//      rules (links in body, one topic, 48-hour window, a thread costs one
//      cadence slot, don't overpromise the hook).
//   2. What this account's own corpus already shows. Where a number exists it is
//      stated, because "deep links run about double the homepage" is a stronger
//      instruction than "prefer deep links".
//
// Every entry answers the same four questions: what FORM the post takes, where
// the LINK goes, what earns the copy-link share for this pillar specifically,
// and the failure mode this pillar actually falls into.

export interface PillarShape {
  /** "single" | "thread" | "either", plus a length steer. */
  form: string;
  /** The structural instruction, handed to the drafter verbatim. */
  build: string;
  /** What makes THIS pillar's posts get pasted into a work channel. */
  citable: string;
  /** The mistake this pillar reliably makes. */
  avoid: string;
}

export const PILLAR_SHAPES: Record<Template, PillarShape> = {
  data_motion_visual: {
    form: "Single post, 2-5 short lines. The animation carries the visual; the copy exists to frame one number.",
    build:
      "Lead with the number, not the setup. One statistic, stated plainly, then the one-line so-what that tells the reader why it is surprising. No preamble, no 'we dug into the data'. If the number needs three sentences of context to land, it is the wrong number.",
    citable:
      "A specific figure someone can quote. This is the pillar most likely to earn a copy-link share, because a number with a clear source is the most pasteable object on the platform. Name the period and the source of the figure so it survives being quoted.",
    avoid:
      "Decorating a number with adjectives instead of comparing it to something. 'Massive growth' is not a fact; 'up from $X in March' is.",
  },

  integration_announcement: {
    form: "Single post, short. A chain going live is news, and news does not need a thread.",
    build:
      "Name the chain, then what it now makes possible for someone building. One concrete capability beats a list of three. The chain's own audience is the reach mechanism here, so make the post something that community would want to quote.",
    citable:
      "Builders paste 'X is live on Y' into their team channels when it changes what they can ship. Say what changes, not that we are excited.",
    avoid:
      "Press-release cadence ('We are thrilled to announce'). Also avoid stacking chain stats to justify the integration; the integration is the news.",
  },

  quote_card: {
    form: "Single post, 1-3 lines above the card.",
    build:
      "The card carries the quote, so the copy must not repeat it. Introduce the person and why this particular claim is worth reading, or state the tension the quote resolves. Attribute by handle when they have one.",
    citable:
      "A named institutional voice saying something specific gets screenshotted and forwarded. The copy's job is to make the reader stop long enough to read the card.",
    avoid:
      "Paraphrasing the quote in the copy, which gives the reader no reason to look at the card.",
  },

  product_post: {
    form: "Single post for a release; a short thread (3-5) when a mechanism needs explaining.",
    build:
      "Problem first, mechanism second, product name last. Lead with the constraint a builder recognises, then how it is removed. Put the docs or blog link in the body. For a partner integration, the partner's shipped thing is the proof, so lead with what they built.",
    citable:
      "An explanation clear enough that someone links it instead of re-explaining the mechanism themselves. That is the bar for this pillar: replace a paragraph someone would otherwise have to type.",
    avoid:
      "Capability lists. Also never state roadmap as shipped, and respect the per-product guardrails handed to you.",
  },

  thought_leadership: {
    form: "Either. A thread (4-7) when the argument needs steps; a tight single post when it is one claim.",
    build:
      "Argue ONE claim pulled out of the piece, do not summarise it. Take a position a reasonable person could disagree with, then support it. Link the piece in the body. End on the part that is genuinely unresolved, which is what earns a considered reply rather than agreement.",
    citable:
      "A frame people adopt. If a reader can restate the argument in one sentence to a colleague, it travels; if it needs the whole thread, it does not.",
    avoid:
      "Restating the article's abstract. Also avoid hedging every claim into uselessness, which is the failure mode of institutional voice.",
  },

  dev_doc_post: {
    form: "Single post, tight. Code or a call signature is welcome.",
    build:
      "Build the post around ONE specific mechanism, pain or parameter named on the page, and deep-link to that page in the body. Never the docs homepage: in this corpus deep-linked posts run roughly double the impressions of homepage posts, so the specificity is the strategy, not a nicety.",
    citable:
      "Developers paste doc links when the link answers a question they were about to ask. Frame the post as the question that page answers.",
    avoid:
      "'Check out our docs.' Also avoid marketing language, which this reader punishes.",
  },

  broad_educational: {
    form:
      "Single post for market news. A thread (3-6) for a curriculum concept, since a mechanism needs steps.",
    build:
      "Eco is NOT named in the body: this is top-of-funnel and Eco's relevance should be inferable, never stated. For news, lead with the fact and give the so-what in one line. For a curriculum concept, earn attention with the parallel and land the break, then link the source in the body.",
    citable:
      "This is the pillar built for the 20.0 signal. A mechanism explained well, with the institution's own source attached, is reference material people link for years. Write it so it is still worth pasting in six months.",
    avoid:
      "Teaching a mechanism without a source behind it. Also avoid crypto triumphalism, which loses the institutional reader who knows the old system better than we do.",
  },

  short_form_video_eco: {
    form: "Single post, 1-2 lines. The copy sits above the video and only has to earn the play.",
    build:
      "The proven shape in this corpus is a question the clip answers, then who is answering it. Lead with the idea inside the clip, never a description of the clip from outside. Refer to the speaker by their exact handle.",
    citable:
      "A clip gets DM-shared when the copy names the specific claim inside it. 'Worth a watch' gets nothing.",
    avoid:
      "Describing the video ('Great conversation with...'). Also note video quality views are weighted 0.0, so do not write for the view, write for the reply.",
  },

  other: {
    form: "Single post.",
    build: "One clear idea, front-loaded hook, link in the body if there is one.",
    citable: "Give the reader one thing worth repeating.",
    avoid: "Trying to do two things in one post.",
  },
};

// Compact block for the prompt. `lane` distinguishes the two jobs inside Broad
// Educational, which are different enough to need different instructions.
export function pillarShapeBlock(template: Template, lane?: "curriculum" | "news"): string {
  const s = PILLAR_SHAPES[template];
  if (!s) return "";
  const laneNote =
    template === "broad_educational" && lane
      ? lane === "curriculum"
        ? "\nLANE: analog curriculum. A thread is usually right. Teach the mechanism, land the break, cite the source."
        : "\nLANE: market news. Single post. Lead with the fact."
      : "";
  return [
    `HOW THIS PILLAR'S POSTS ARE BUILT:`,
    `  Form: ${s.form}`,
    `  Build: ${s.build}`,
    `  What earns the copy-link share here: ${s.citable}`,
    `  Avoid: ${s.avoid}`,
    laneNote,
  ]
    .filter(Boolean)
    .join("\n");
}
