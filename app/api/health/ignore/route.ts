import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { isIsoDate } from "@/lib/nutrition";
import { loadIgnoredDates, setNightIgnored } from "@/lib/health-ignored";

export const dynamic = "force-dynamic";

// The nights the Health page ignores. GET → { dates }. POST { date, ignored } → ignore (true) or include again (false)
// that night; answers with the new list.
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ dates: loadIgnoredDates() });
}

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => null) as { date?: unknown; ignored?: unknown } | null;
  if (!isIsoDate(b?.date) || typeof b?.ignored !== "boolean") {
    return NextResponse.json({ error: "date (YYYY-MM-DD) and ignored (true/false) are required" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, dates: setNightIgnored(b.date, b.ignored) });
}
