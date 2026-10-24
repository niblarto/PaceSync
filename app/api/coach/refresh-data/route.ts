import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { prefetchCoachData } from "@/lib/coach-context";
import { ensureBrief, markBriefStale } from "@/lib/coach-brief";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Called after every GarminDB sync (scripts/garmin_after_sync.sh) so laps,
// weather and HRV are stored before the Coach needs them.
export async function POST(req: NextRequest) {
  const hasCronSecret = process.env.CRON_SECRET && req.headers.get("X-Cron-Secret") === process.env.CRON_SECRET;
  if (!hasCronSecret && !(await hasApiAccess(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await prefetchCoachData();
  console.log(`[coach] post-sync refresh: ${result.runs} runs, ${result.laps} with laps, ${result.weather} with weather, ${result.hrvDays} HRV days`);
  // New activity data: the dashboard's two-week summary is out of date. Write
  // a fresh one now if the AI is up; otherwise the hourly cron does it later.
  markBriefStale();
  const brief = await ensureBrief().catch(() => null);
  return NextResponse.json({ ok: true, ...result, brief: brief?.status ?? null });
}
