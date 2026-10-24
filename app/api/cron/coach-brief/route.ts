import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { briefStatus, ensureBrief } from "@/lib/coach-brief";

export const dynamic = "force-dynamic";

// Hourly cron: if an activity update has made the dashboard's two-week summary
// stale and the AI service wasn't reachable at the time, writes it now that it
// is. Does nothing when the summary is up to date. Same X-Cron-Secret-or-session
// auth as the other /api/cron/* routes.
export async function POST(req: NextRequest) {
  const hasCronSecret = !!process.env.CRON_SECRET && req.headers.get("X-Cron-Secret") === process.env.CRON_SECRET;
  if (!hasCronSecret && !(await getServerSession(authOptions))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // The plan lines are included so the cron log shows what the panel displays.
  const { facts, stale } = await briefStatus();
  return NextResponse.json({ ...(await ensureBrief({ force: req.nextUrl.searchParams.get("force") === "1" })), stale, facts: facts?.lines ?? null });
}
