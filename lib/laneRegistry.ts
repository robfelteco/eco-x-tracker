import {
  CHAIN_HANDLES,
  CHAIN_KEYWORDS,
  CHAIN_LABELS,
  ENTITY_DOMAINS,
  ENTITY_HANDLES,
  ENTITY_LABELS,
  installLaneLabels,
  type ExtraVocab,
  type LaneVocabEntry,
} from "./dimensions.ts";
import { PRODUCT_DEFS, productLabel } from "./products.ts";

// The lane registry (Migration 019): the union of the code registries and the
// `lane_registry` table, read once per sync / per page load.
//
// The problem it solves is stated in the migration. In one line: classification
// generalises to things it has never seen, dimension tagging does not, and
// every lane in Prioritize is built by unnesting a tagged array. So a chain or
// product that is not in the code produces a post in the right pillar and a
// lane nowhere — Arc, Smart Deposits and the B2C2 integration were all sitting
// in that state at once.
//
// Code stays the seed rather than being migrated wholesale into the table. The
// code entries carry briefs, guardrails and the deliberate exclusions that took
// work to get right (the phantom "Stellar" chip, `routes` as a loose term), and
// those are worth keeping under review in a file. The table is where growth
// happens.

export type LaneKind = "chain" | "product" | "partner";

export const LANE_KINDS: LaneKind[] = ["chain", "product", "partner"];

export interface LaneRow {
  kind: LaneKind;
  id: string;
  label: string;
  handles: string[];
  terms: string[];
  looseTerms: string[];
  domains: string[];
  brief: string | null;
  guardrail: string | null;
  status: "active" | "dismissed" | "merged";
  source: "code" | "auto" | "human";
  reviewed: boolean;
  evidencePostId: string | null;
  evidenceNote: string | null;
  mergedInto: string | null;
  createdAt: string | null;
}

type SqlTag = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...params: unknown[]
) => Promise<T[]>;

// ---------------------------------------------------------------------------
// Which entities are Eco INTEGRATION PARTNERS
//
// lib/dimensions.ts ENTITY_LABELS is a wider set than this on purpose: it holds
// every company worth tagging, including ones we only ever write ABOUT (Visa,
// DoorDash, MoneyGram appear in market posts and have never shipped Eco infra).
// A partner lane is a commitment to keep posting about that relationship, so it
// can only be drawn for companies actually running Eco in production. Listing
// them by hand is the honest version of that distinction; the detector grows
// the list from here.
export const CODE_PARTNERS: Record<string, string> = {
  circle: "Gateway + Agent Stack run Eco underneath; the most-posted partner in the pillar.",
  para: "Shipped Permit3 in production as Transaction Permissions.",
  lifi: "Routes @eco liquidity through LI.FI / Jumper.",
};

// ---------------------------------------------------------------------------
// Code seeds, shaped as registry rows so the two sources merge cleanly.

function codeChainRows(): LaneRow[] {
  // Invert the handle map: one chain can answer to several handles.
  const handlesByChain = new Map<string, string[]>();
  for (const [handle, chain] of Object.entries(CHAIN_HANDLES)) {
    handlesByChain.set(chain, [...(handlesByChain.get(chain) ?? []), handle]);
  }
  return Object.entries(CHAIN_LABELS).map(([id, label]) => ({
    kind: "chain" as const,
    id,
    label,
    handles: handlesByChain.get(id) ?? [],
    terms: CHAIN_KEYWORDS[id] ?? [],
    looseTerms: [],
    domains: [],
    brief: null,
    guardrail: null,
    status: "active" as const,
    source: "code" as const,
    reviewed: true,
    evidencePostId: null,
    evidenceNote: null,
    mergedInto: null,
    createdAt: null,
  }));
}

function codeProductRows(): LaneRow[] {
  return PRODUCT_DEFS.map((p) => ({
    kind: "product" as const,
    id: p.id,
    label: p.label,
    handles: [],
    terms: p.terms,
    looseTerms: p.looseTerms ?? [],
    domains: [],
    brief: p.brief,
    guardrail: p.guardrail ?? null,
    status: "active" as const,
    source: "code" as const,
    reviewed: true,
    evidencePostId: null,
    evidenceNote: null,
    mergedInto: null,
    createdAt: null,
  }));
}

function codePartnerRows(): LaneRow[] {
  const handlesByEntity = new Map<string, string[]>();
  for (const [handle, entity] of Object.entries(ENTITY_HANDLES)) {
    handlesByEntity.set(entity, [...(handlesByEntity.get(entity) ?? []), handle]);
  }
  const domainsByEntity = new Map<string, string[]>();
  for (const [domain, entity] of Object.entries(ENTITY_DOMAINS)) {
    domainsByEntity.set(entity, [...(domainsByEntity.get(entity) ?? []), domain]);
  }
  return Object.entries(CODE_PARTNERS).map(([id, brief]) => ({
    kind: "partner" as const,
    id,
    label: ENTITY_LABELS[id] ?? id,
    handles: handlesByEntity.get(id) ?? [],
    terms: [],
    looseTerms: [],
    domains: domainsByEntity.get(id) ?? [],
    brief,
    guardrail: null,
    status: "active" as const,
    source: "code" as const,
    reviewed: true,
    evidencePostId: null,
    evidenceNote: null,
    mergedInto: null,
    createdAt: null,
  }));
}

export function codeLanes(): LaneRow[] {
  return [...codeChainRows(), ...codeProductRows(), ...codePartnerRows()];
}

// ---------------------------------------------------------------------------
// The merged view.

export interface LaneRegistry {
  /** Every lane, code and table, including dismissed/merged rows. */
  all: LaneRow[];
  /** Active lanes by kind, code first. What the UI draws lanes from. */
  byKind: Record<LaneKind, LaneRow[]>;
  /** id → label per kind, for display. */
  labels: Record<LaneKind, Record<string, string>>;
  /** Matching vocabulary for the table rows only — code vocab is already compiled into lib/dimensions.ts. */
  vocab: ExtraVocab;
  /** Auto-detected and not yet looked at. Drives the review tray. */
  pending: LaneRow[];
  /** kind|id of lanes an operator dismissed — tagging must not resurrect them. */
  dismissed: Set<string>;
  /** kind|id → the lane it was folded into. */
  mergedInto: Map<string, string>;
}

function toVocabEntry(r: LaneRow): LaneVocabEntry {
  return {
    // A merged lane tags as its TARGET. That is what "merge" has to mean: the
    // rows already written keep matching, and everything they match lands in
    // the lane the operator chose to keep.
    id: r.mergedInto ?? r.id,
    handles: r.handles,
    terms: r.terms,
    looseTerms: r.looseTerms,
    domains: r.domains,
  };
}

export async function getLaneRegistry(sql: SqlTag): Promise<LaneRegistry> {
  const rows = await sql<{
    kind: LaneKind;
    id: string;
    label: string;
    handles: string[];
    terms: string[];
    loose_terms: string[];
    domains: string[];
    brief: string | null;
    guardrail: string | null;
    status: LaneRow["status"];
    source: LaneRow["source"];
    reviewed: boolean;
    evidence_post_id: string | null;
    evidence_note: string | null;
    merged_into: string | null;
    created_at: string;
  }>`SELECT * FROM lane_registry ORDER BY created_at`;

  const dbRows: LaneRow[] = rows.map((r) => ({
    kind: r.kind,
    id: r.id,
    label: r.label,
    handles: r.handles ?? [],
    terms: r.terms ?? [],
    looseTerms: r.loose_terms ?? [],
    domains: r.domains ?? [],
    brief: r.brief,
    guardrail: r.guardrail,
    status: r.status,
    source: r.source,
    reviewed: r.reviewed,
    evidencePostId: r.evidence_post_id,
    evidenceNote: r.evidence_note,
    mergedInto: r.merged_into,
    createdAt: r.created_at,
  }));

  const code = codeLanes();
  const codeKeys = new Set(code.map((r) => `${r.kind}|${r.id}`));
  // A table row for an id the code already defines is an OVERRIDE, not a
  // duplicate — that is how an operator renames or re-briefs a code lane
  // without a deploy. Its vocabulary is unioned with the code vocabulary
  // rather than replacing it, so a rename can never silently stop matching.
  const overrides = new Map(dbRows.filter((r) => codeKeys.has(`${r.kind}|${r.id}`)).map((r) => [`${r.kind}|${r.id}`, r]));

  const all: LaneRow[] = [
    ...code.map((c) => {
      const o = overrides.get(`${c.kind}|${c.id}`);
      return o ? { ...c, ...o, source: c.source, handles: [...new Set([...c.handles, ...o.handles])] } : c;
    }),
    ...dbRows.filter((r) => !codeKeys.has(`${r.kind}|${r.id}`)),
  ];

  const byKind: Record<LaneKind, LaneRow[]> = { chain: [], product: [], partner: [] };
  const labels: Record<LaneKind, Record<string, string>> = { chain: {}, product: {}, partner: {} };
  const dismissed = new Set<string>();
  const mergedInto = new Map<string, string>();

  for (const r of all) {
    labels[r.kind][r.id] = r.label;
    if (r.status === "dismissed") dismissed.add(`${r.kind}|${r.id}`);
    if (r.status === "merged" && r.mergedInto) mergedInto.set(`${r.kind}|${r.id}`, r.mergedInto);
    if (r.status === "active") byKind[r.kind].push(r);
  }

  // Everything downstream renders labels synchronously — install them once.
  installLaneLabels(labels.chain, { ...labels.partner });

  const liveDbRows = dbRows.filter((r) => r.status !== "dismissed");
  const vocab: ExtraVocab = {
    chain: liveDbRows.filter((r) => r.kind === "chain").map(toVocabEntry),
    product: liveDbRows.filter((r) => r.kind === "product").map(toVocabEntry),
    partner: liveDbRows.filter((r) => r.kind === "partner").map(toVocabEntry),
  };

  return {
    all,
    byKind,
    labels,
    vocab,
    pending: all.filter((r) => r.source === "auto" && !r.reviewed && r.status === "active"),
    dismissed,
    mergedInto,
  };
}

/** The lanes list handed to the detector, so it can answer "we already have this". */
export function laneDirectory(reg: LaneRegistry): string {
  return LANE_KINDS.map((k) => {
    const list = reg.byKind[k].map((r) => `${r.id} (${r.label})`).join(", ");
    return `${k}: ${list || "none"}`;
  }).join("\n");
}

export function laneLabel(reg: LaneRegistry, kind: LaneKind, id: string): string {
  return reg.labels[kind][id] ?? id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Product label that also knows registry-only products (Smart Deposits et al). */
export function productLabelWith(reg: LaneRegistry | null, id: string): string {
  return reg?.labels.product[id] ?? productLabel(id);
}

// ---------------------------------------------------------------------------
// Writes.

export interface LaneProposal {
  kind: LaneKind;
  id: string;
  label: string;
  handles?: string[];
  terms?: string[];
  looseTerms?: string[];
  domains?: string[];
  brief?: string | null;
  guardrail?: string | null;
  evidencePostId?: string | null;
  evidenceNote?: string | null;
  source?: LaneRow["source"];
  reviewed?: boolean;
}

/**
 * Write a detected lane. Never resurrects a lane an operator dismissed or
 * merged away, and never overwrites a human edit — re-detection of the same
 * lane only widens its vocabulary.
 */
export async function upsertLane(sql: SqlTag, p: LaneProposal): Promise<void> {
  await sql`
    INSERT INTO lane_registry (
      kind, id, label, handles, terms, loose_terms, domains,
      brief, guardrail, source, reviewed, evidence_post_id, evidence_note
    ) VALUES (
      ${p.kind}, ${p.id}, ${p.label},
      ${p.handles ?? []}, ${p.terms ?? []}, ${p.looseTerms ?? []}, ${p.domains ?? []},
      ${p.brief ?? null}, ${p.guardrail ?? null},
      ${p.source ?? "auto"}, ${p.reviewed ?? false},
      ${p.evidencePostId ?? null}, ${p.evidenceNote ?? null}
    )
    ON CONFLICT (kind, id) DO UPDATE SET
      -- Widen the vocabulary, never narrow it: a second sighting of a lane is
      -- new evidence about how it is written about, not a correction.
      -- COALESCE because array_agg over an empty set is NULL, not '{}' — and
      -- these columns are NOT NULL. A lane whose vocabulary is entirely
      -- @handles (the common case for a partner) hits that on every re-write.
      handles     = COALESCE((SELECT array_agg(DISTINCT h) FROM unnest(lane_registry.handles     || EXCLUDED.handles)     h), '{}'),
      terms       = COALESCE((SELECT array_agg(DISTINCT t) FROM unnest(lane_registry.terms       || EXCLUDED.terms)       t), '{}'),
      loose_terms = COALESCE((SELECT array_agg(DISTINCT t) FROM unnest(lane_registry.loose_terms || EXCLUDED.loose_terms) t), '{}'),
      domains     = COALESCE((SELECT array_agg(DISTINCT d) FROM unnest(lane_registry.domains     || EXCLUDED.domains)     d), '{}'),
      -- A label or brief an operator touched outranks anything re-derived.
      label = CASE WHEN lane_registry.source = 'human' THEN lane_registry.label ELSE EXCLUDED.label END,
      brief = COALESCE(lane_registry.brief, EXCLUDED.brief),
      updated_at = now()
  `;
}

export type LaneReviewAction = "confirm" | "rename" | "merge" | "dismiss";

export async function reviewLane(
  sql: SqlTag,
  kind: LaneKind,
  id: string,
  action: LaneReviewAction,
  value?: string,
): Promise<void> {
  if (action === "confirm") {
    await sql`UPDATE lane_registry SET reviewed = true, source = 'human', updated_at = now() WHERE kind = ${kind} AND id = ${id}`;
    return;
  }
  if (action === "rename") {
    await sql`UPDATE lane_registry SET label = ${value ?? id}, reviewed = true, source = 'human', updated_at = now() WHERE kind = ${kind} AND id = ${id}`;
    return;
  }
  if (action === "merge") {
    if (!value) throw new Error("merge needs a target lane id");
    await sql`UPDATE lane_registry SET status = 'merged', merged_into = ${value}, reviewed = true, source = 'human', updated_at = now() WHERE kind = ${kind} AND id = ${id}`;
    return;
  }
  await sql`UPDATE lane_registry SET status = 'dismissed', reviewed = true, source = 'human', updated_at = now() WHERE kind = ${kind} AND id = ${id}`;
}
