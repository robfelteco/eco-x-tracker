import { NextRequest, NextResponse } from "next/server";
import { discover } from "@/lib/discover";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Discover fresh broad-educational source material (Grok web + X search). Spends
// xAI credits, so it only runs on an explicit click. We pass Grok the titles of
// everything @eco has already posted in broad_educational so it never resurfaces
// a piece we've used — the pillar's no-reshare rule, enforced at the source.
export async function POST(req: NextRequest) {
  try {
    const posted = await sql<{ title: string }>`
      SELECT COALESCE(NULLIF(link_title, ''), left(text, 120)) AS title
      FROM posts
      WHERE template = 'broad_educational' AND is_reply = false
      ORDER BY created_at DESC
      LIMIT 60
    `;
    const excludeTitles = posted.map((r) => r.title).filter(Boolean);
    const { items, warnings } = await discover(excludeTitles);
    return NextResponse.json({ ok: true, items, warnings }, { status: 200 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
