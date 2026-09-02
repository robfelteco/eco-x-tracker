import { ANALOG_DEFS } from "./analogs.ts";

// The Broad Educational angle bank.
//
// This pillar was the one whose card offered a draft it could not write. The
// curriculum shelf works, the source sweep works, the grounding check works —
// and the drafts off the back of them did not land, for a reason that is
// upstream of drafting. The missing step is the FRAME. "Stablecoins are
// inevitable" is the register we are trying to leave; the replacement is
// something like "here is what financial routing costs today, here is what
// settles on-chain, we are in the first inning" — and that is a thing a person
// works out by arguing with the material, not a thing a sweep returns.
//
// Jay's call on 2 Sep, on this specific pillar: "I would actually not try to do
// the engine yet… focus on trying to figure out if you can manually create
// templates based on the references you have… for now I wouldn't even automate
// it because it's just way too hard." And on what the tool should be instead:
// "as long as it says broad education, you haven't done it yet, then you know
// that you have to do it… more of like a project management tool."
//
// So the pillar stops generating and starts keeping score of the thinking. One
// row per angle: the frame, the mechanism it explains, the bridge to Eco (the
// hard half, and the one most likely to be blank on a first pass), the evidence,
// and whether it has been used. The card becomes "12 concepts never covered, 3
// angles banked" — which is a real answer to "what should I do here today".
//
// Drafting is untouched on the pillars that earn it: quote cards, product posts,
// chain integrations.

export type AngleStatus = "banked" | "used" | "parked";

export interface EducationAngle {
  id: number;
  analogId: string | null;
  analogLabel: string | null;
  frame: string;
  mechanism: string | null;
  ecoBridge: string | null;
  icp: string | null;
  sourceUrl: string | null;
  sourceNote: string | null;
  status: AngleStatus;
  usedPostId: string | null;
  usedPostUrl: string | null;
  usedAt: string | null;
  createdAt: string;
}

export interface AngleBank {
  angles: EducationAngle[];
  banked: number;
  used: number;
  parked: number;
  /** Banked angles still missing the Eco bridge — the half that stalls drafting. */
  missingBridge: number;
}

type SqlTag = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...params: unknown[]
) => Promise<T[]>;

const ANALOG_LABEL = new Map(ANALOG_DEFS.map((d) => [d.id, d.label]));

export async function getAngleBank(sql: SqlTag): Promise<AngleBank> {
  const rows = await sql<{
    id: number;
    analogId: string | null;
    frame: string;
    mechanism: string | null;
    ecoBridge: string | null;
    icp: string | null;
    sourceUrl: string | null;
    sourceNote: string | null;
    status: AngleStatus;
    usedPostId: string | null;
    usedPostUrl: string | null;
    usedAt: string | null;
    createdAt: string;
  }>`
    SELECT a.id::int AS id, a.analog_id AS "analogId", a.frame, a.mechanism,
           a.eco_bridge AS "ecoBridge", a.icp, a.source_url AS "sourceUrl",
           a.source_note AS "sourceNote", a.status,
           a.used_post_id AS "usedPostId", p.url AS "usedPostUrl",
           a.used_at AS "usedAt", a.created_at AS "createdAt"
    FROM education_angles a
    LEFT JOIN posts p ON p.id = a.used_post_id
    ORDER BY
      -- Banked first (they are the to-do list), then parked, then used. Within
      -- each, newest first.
      CASE a.status WHEN 'banked' THEN 0 WHEN 'parked' THEN 1 ELSE 2 END,
      a.created_at DESC
  `;

  const angles: EducationAngle[] = rows.map((r) => ({
    ...r,
    id: Number(r.id),
    analogLabel: r.analogId ? (ANALOG_LABEL.get(r.analogId) ?? r.analogId) : null,
  }));

  return {
    angles,
    banked: angles.filter((a) => a.status === "banked").length,
    used: angles.filter((a) => a.status === "used").length,
    parked: angles.filter((a) => a.status === "parked").length,
    missingBridge: angles.filter((a) => a.status === "banked" && !a.ecoBridge?.trim()).length,
  };
}

export interface SaveAngleInput {
  id?: number | null;
  analogId?: string | null;
  frame: string;
  mechanism?: string | null;
  ecoBridge?: string | null;
  icp?: string | null;
  sourceUrl?: string | null;
  sourceNote?: string | null;
}

/** Insert or update one angle. Returns its id. */
export async function saveAngle(sql: SqlTag, input: SaveAngleInput): Promise<number> {
  const frame = input.frame.trim();
  if (!frame) throw new Error("An angle needs a frame — the one line you'd pitch it as.");
  const nz = (v: string | null | undefined) => {
    const t = (v ?? "").trim();
    return t ? t : null;
  };

  if (input.id) {
    const rows = await sql<{ id: number }>`
      UPDATE education_angles SET
        analog_id   = ${nz(input.analogId)},
        frame       = ${frame},
        mechanism   = ${nz(input.mechanism)},
        eco_bridge  = ${nz(input.ecoBridge)},
        icp         = ${nz(input.icp)},
        source_url  = ${nz(input.sourceUrl)},
        source_note = ${nz(input.sourceNote)},
        updated_at  = now()
      WHERE id = ${input.id}
      RETURNING id::int AS id
    `;
    if (!rows.length) throw new Error(`No angle #${input.id}`);
    return Number(rows[0].id);
  }

  const rows = await sql<{ id: number }>`
    INSERT INTO education_angles (analog_id, frame, mechanism, eco_bridge, icp, source_url, source_note)
    VALUES (${nz(input.analogId)}, ${frame}, ${nz(input.mechanism)}, ${nz(input.ecoBridge)},
            ${nz(input.icp)}, ${nz(input.sourceUrl)}, ${nz(input.sourceNote)})
    RETURNING id::int AS id
  `;
  return Number(rows[0].id);
}

/**
 * Move an angle between states.
 *
 * 'used' takes an optional post id. It is optional on purpose: the post usually
 * does not exist in `posts` yet — it lands at the next sync — and making the
 * operator wait a day to tick something off is how a project-management tool
 * stops being used. The link can be attached later, or never.
 */
export async function setAngleStatus(
  sql: SqlTag,
  id: number,
  status: AngleStatus,
  postId?: string | null,
): Promise<void> {
  await sql`
    UPDATE education_angles SET
      status       = ${status},
      used_post_id = ${status === "used" ? (postId ?? null) : null},
      used_at      = ${status === "used" ? new Date().toISOString() : null},
      updated_at   = now()
    WHERE id = ${id}
  `;
}

export async function deleteAngle(sql: SqlTag, id: number): Promise<void> {
  await sql`DELETE FROM education_angles WHERE id = ${id}`;
}
