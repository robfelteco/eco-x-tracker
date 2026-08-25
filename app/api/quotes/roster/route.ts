import { NextRequest, NextResponse } from "next/server";
import { getRosterSuggestions, addSuggestionToRoster, ignoreSuggestion } from "@/lib/quoteDiscovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The "Add to roster?" tray — how the roster grows without hand-curation, while
// the expensive read budget stays pointed at people already vetted (spec §5.5).
export async function GET() {
  try {
    return NextResponse.json({ ok: true, suggestions: await getRosterSuggestions() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { id, action, fullName, title, orgName, seniority } = await req.json();
    if (!Number.isFinite(id)) return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
    if (action === "ignore") {
      await ignoreSuggestion(Number(id));
      return NextResponse.json({ ok: true });
    }
    if (!fullName || !title) {
      return NextResponse.json({ ok: false, error: "fullName and title are required to add" }, { status: 400 });
    }
    const ok = await addSuggestionToRoster(Number(id), {
      fullName,
      title,
      orgName: orgName ?? null,
      seniority: [1, 2, 3].includes(seniority) ? seniority : 3,
    });
    return NextResponse.json({ ok });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
