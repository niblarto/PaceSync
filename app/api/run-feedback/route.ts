import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { getRunFeedback, listRunFeedback, saveRunFeedback } from "@/lib/run-feedback";

export const dynamic = "force-dynamic";

// GET ?from=YYYY-MM-DD[&to=] -> { feedback: [...] }
// GET ?date=&title=          -> { feedback: {...} | null }
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const p = req.nextUrl.searchParams;
  const date = p.get("date");
  const title = p.get("title");
  if (date && title != null) return NextResponse.json({ feedback: getRunFeedback(date, title) });
  return NextResponse.json({ feedback: listRunFeedback(p.get("from") ?? "0000-00-00", p.get("to") ?? undefined) });
}

// POST { date, title, effort, feel, notes } — all three empty clears it.
export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json() as { date?: string; title?: string; effort?: number | null; feel?: number | null; notes?: string | null };
  if (!b.date || !/^\d{4}-\d{2}-\d{2}$/.test(b.date) || typeof b.title !== "string") {
    return NextResponse.json({ error: "date and title required" }, { status: 400 });
  }
  return NextResponse.json({ feedback: saveRunFeedback(b.date, b.title, b.effort ?? null, b.feel ?? null, b.notes ?? null) });
}
