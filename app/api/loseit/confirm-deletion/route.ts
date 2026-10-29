import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { isIsoDate } from "@/lib/nutrition";
import { pendingMealDeletion, resolveMissingMeals } from "@/lib/loseit-food";

export const dynamic = "force-dynamic";

// POST { date, deleted: boolean } → answers "Lose It! no longer shows a meal; was it deleted?" (see the diary's
// pendingDeletion). deleted: true removes it (what Lose It! shows now is applied); false keeps it and starts the
// checks again. Answers with the day's diary.
export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => null) as { date?: unknown; deleted?: unknown } | null;
  if (!isIsoDate(b?.date) || typeof b?.deleted !== "boolean") {
    return NextResponse.json({ error: "date and deleted (true/false) are required" }, { status: 400 });
  }
  try {
    const day = await resolveMissingMeals(b.date, b.deleted);
    return NextResponse.json({ ...day, pendingDeletion: pendingMealDeletion(b.date) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
