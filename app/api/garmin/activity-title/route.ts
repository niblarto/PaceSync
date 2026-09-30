import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { setActivityTitleOverride } from "@/lib/garmin-activity-titles";

// Sets (or, with a blank title, clears) a Garmin activity's display-title
// override — see lib/garmin-activity-titles.ts's own comment for why this
// never touches GarminDB itself.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { activityId, title } = await req.json() as { activityId?: string; title?: string };
  if (!activityId) return NextResponse.json({ error: "activityId is required" }, { status: 400 });
  setActivityTitleOverride(activityId, title ?? "");
  return NextResponse.json({ ok: true });
}
