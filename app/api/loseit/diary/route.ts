import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { isIsoDate } from "@/lib/nutrition";
import { getDiaryDay, getLoseItStatus, localIsoDate, syncLoseIt } from "@/lib/loseit-food";

export const dynamic = "force-dynamic";

// GET ?date=YYYY-MM-DD (default today) → that day's Lose It! foods by meal.
// &refresh=1 → first sync today/yesterday from Lose It! (throttled to once
// per 5 minutes inside syncLoseIt, so opening the screen repeatedly is cheap).
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const q = req.nextUrl.searchParams;
  const date = q.get("date") ?? localIsoDate();
  if (!isIsoDate(date)) return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });

  let sync = null;
  if (q.get("refresh") === "1") sync = await syncLoseIt();
  const status = getLoseItStatus();
  return NextResponse.json({
    ...getDiaryDay(date),
    sync,
    connected: status.connected,
    lastSyncAt: status.lastDaySyncAt,
    lastError: status.lastError,
  });
}
