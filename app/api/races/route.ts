import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listRaces, getRaceByGarminActivity, createRace, type RaceStatus } from "@/lib/races";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ?garminActivityId=<id> — the Garmin activity page's own "🏁 Race"
// checkbox state check (does a races row already exist for THIS
// activity?), instead of fetching and scanning the whole list client-side.
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const activityId = req.nextUrl.searchParams.get("garminActivityId");
  if (activityId) {
    const race = getRaceByGarminActivity(activityId);
    return NextResponse.json({ race });
  }
  return NextResponse.json({ races: listRaces() });
}

// "+ Add upcoming race" on the Races page — a race not (yet) in Runna's
// own schedule feed at all (further out than its 28-day window, or booked
// outside the Runna plan entirely).
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as {
    name?: string; raceDate?: string | null; status?: RaceStatus;
    garminActivityId?: string | null; runnaUid?: string | null; distanceMi?: number | null; notes?: string | null;
  };
  if (!body.name?.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (body.raceDate && !DATE_RE.test(body.raceDate)) {
    return NextResponse.json({ error: "raceDate must be YYYY-MM-DD" }, { status: 400 });
  }
  const status: RaceStatus = body.status === "completed" ? "completed" : "upcoming";

  const race = createRace({
    name: body.name,
    raceDate: body.raceDate ?? null,
    status,
    garminActivityId: body.garminActivityId ?? null,
    runnaUid: body.runnaUid ?? null,
    distanceMi: body.distanceMi ?? null,
    notes: body.notes ?? null,
  });
  return NextResponse.json({ race });
}
