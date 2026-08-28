import { NextRequest, NextResponse } from "next/server";
import { mineQuestions } from "@/lib/questions";
import { ANALOG_BY_ID } from "@/lib/analogs";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Mine the questions people actually ask about one curriculum concept. Spends
// xAI credits, so it only runs on an explicit click.
//
// The exclude list is built from posts we have already published about this
// concept: a question we have answered is not an opportunity, and re-surfacing
// it would make the shelf repeat itself the way broad-educational would without
// its no-reshare rule.
export async function POST(req: NextRequest) {
  try {
    const { analogId } = await req.json();
    if (typeof analogId !== "string" || !ANALOG_BY_ID[analogId]) {
      return NextResponse.json({ ok: false, error: "a valid analogId is required" }, { status: 400 });
    }

    const answered = await sql<{ text: string }>`
      SELECT COALESCE(NULLIF(link_title, ''), left(text, 160)) AS text
      FROM posts
      WHERE analog_id = ${analogId} AND is_reply = false
      ORDER BY created_at DESC
      LIMIT 20
    `;

    const { questions, warnings } = await mineQuestions(
      analogId,
      answered.map((r) => r.text).filter(Boolean),
    );
    return NextResponse.json({ ok: true, questions, warnings }, { status: 200 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
