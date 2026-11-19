import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { isIsoDate } from "@/lib/nutrition";
import { getLoseItStatus, localIsoDate, pendingMealDeletion, syncLoseItDay } from "@/lib/loseit-food";

export const dynamic = "force-dynamic";

// POST { date } → re-read that one day from Lose It! now (a past day's "Sync" button) and answer with its diary, in
// the shape of GET /api/loseit/diary. One small request to Lose It!; the day is never in the future.
export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => null) as { date?: unknown } | null;
  if (!isIsoDate(b?.date)) return NextResponse.json({ error: "date (YYYY-MM-DD) is required" }, { status: 400 });
  if (b.date > localIsoDate()) return NextResponse.json({ error: "That day hasn't happened yet" }, { status: 400 });
  try {
    const day = await syncLoseItDay(b.date);
    const status = getLoseItStatus();
    return NextResponse.json({
      ...day,
      pendingDeletion: pendingMealDeletion(b.date),
      sync: { status: "synced" },
      connected: status.connected,
      lastSyncAt: status.lastDaySyncAt,
      lastError: status.lastError,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
