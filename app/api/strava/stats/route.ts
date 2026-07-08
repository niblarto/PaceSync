import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getFreshStravaToken, getAthlete, getAthleteZones, listActivities } from "@/lib/strava";
import { loadStravaTokens, clearStravaTokens } from "@/lib/strava-tokens";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!loadStravaTokens()) {
    return NextResponse.json({ connected: false });
  }

  const tokenResult = await getFreshStravaToken();
  if (!tokenResult.ok) {
    if (tokenResult.reason === "refresh_failed") clearStravaTokens();
    return NextResponse.json({ connected: false, error: tokenResult.reason });
  }
  const token = tokenResult.token;

  try {
    const [athlete, zones, activities] = await Promise.all([
      getAthlete(token),
      getAthleteZones(token).catch(() => null), // zones can be private/unset
      listActivities(token, 30),
    ]);
    return NextResponse.json({ connected: true, athlete, zones, activities });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

export async function DELETE() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  clearStravaTokens();
  return NextResponse.json({ ok: true });
}
