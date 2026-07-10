import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { syncWorkoutToStravaActivity } from "@/lib/strava-workout-sync";

// Manual retry for the "🎧 Runna title update failed" ntfy alert: the
// webhook already polls Runna's schedule for 20 min after upload, so if it
// still couldn't match a workout, waiting more won't help without user
// action (e.g. Runna is just slow that day) — skipWait re-checks once, now.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { activityId } = await req.json() as { activityId?: number | string };
  if (!activityId) return NextResponse.json({ error: "activityId required" }, { status: 400 });

  const result = await syncWorkoutToStravaActivity(activityId, { skipWait: true });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
  return NextResponse.json(result);
}
