import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { setSavedPaceProMixActivity } from "@/lib/pace-pro-saved";

// Attaches (or clears, with activityId: null) a GarminDB activity id as a
// saved Pace Pro mix's route/map — the id must already be a real GarminDB
// activity_id (no live Garmin Connect lookup happens here or anywhere in
// this app); /api/garmin/route/[id] and /api/garmin/activity/[id] are what
// actually validate it exists when the map is opened.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, activityId } = await req.json() as { id?: string; activityId?: string | null };
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const applied = setSavedPaceProMixActivity(id, activityId ? String(activityId).trim() : null);
  if (!applied) return NextResponse.json({ error: "Saved mix not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
