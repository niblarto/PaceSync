import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { refreshGarminWeights } from "@/lib/garmin-weight";

export const dynamic = "force-dynamic";

// Hourly cron: pulls the last week of weigh-ins from Garmin Connect, so the
// current weight (Nutrition page, Coach) never waits on the phone or on
// GarminDB's 06:00 sync. Same X-Cron-Secret-or-session auth as the other
// /api/cron/* routes.
export async function POST(req: NextRequest) {
  const hasCronSecret = !!process.env.CRON_SECRET && req.headers.get("X-Cron-Secret") === process.env.CRON_SECRET;
  if (!hasCronSecret && !(await getServerSession(authOptions))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await refreshGarminWeights(7);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
  return NextResponse.json(result);
}
