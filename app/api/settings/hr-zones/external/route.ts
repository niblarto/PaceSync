import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadGarminConfig } from "@/lib/garmin-config";
import { getFreshStravaToken, getAthleteZones } from "@/lib/strava";
import type { HRZone } from "@/types";
import path from "path";

// Pulls a ready-to-use 5-zone HR set from Garmin or Strava, for the "source"
// picker on the Heart Rate Settings card. Neither service's zones are stored
// as a standalone config PaceSync can read directly:
//   - Garmin: GarminDB has no zones table: each activity row just carries the
//     6-zone floors your device was configured with when it recorded that
//     activity (hrz_1_hr..hrz_5_hr + implicit max as top of Z6). We fold
//     Garmin's Z1+Z2 into one band to match PaceSync's 5-zone model — Z1 is
//     conventionally an "active recovery/warm up" band below true aerobic
//     effort, so merging it with Z2 (rather than the top end) is standard
//     practice when collapsing 6 zones to 5.
//   - Strava: /athlete/zones already returns 5 HR zones directly.
function garminZonesFromActivity(dbPath: string): HRZone[] | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(path.join(dbPath, "garmin_activities.db"), { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 30000");
    const row = db.prepare(`
      SELECT hrz_1_hr, hrz_2_hr, hrz_3_hr, hrz_4_hr, hrz_5_hr, max_hr
      FROM activities
      WHERE hrz_1_hr IS NOT NULL AND hrz_2_hr IS NOT NULL
      ORDER BY start_time DESC LIMIT 1
    `).get() as { hrz_1_hr: number; hrz_2_hr: number; hrz_3_hr: number; hrz_4_hr: number; hrz_5_hr: number; max_hr: number | null } | undefined;
    db.close();
    if (!row) return null;

    // Garmin's hrz_N_hr is each zone's FLOOR; Z1 floor is usually 0.
    // Fold Z1+Z2 -> PaceSync Z1, then Z3..Z5 become PaceSync Z2..Z4, and the
    // observed max_hr (or a small pad above Z5's floor) caps PaceSync Z5.
    const top = (row.max_hr && row.max_hr > row.hrz_5_hr) ? row.max_hr : row.hrz_5_hr + 20;
    return [
      { min: 0, max: row.hrz_3_hr - 1 },
      { min: row.hrz_3_hr, max: row.hrz_4_hr - 1 },
      { min: row.hrz_4_hr, max: row.hrz_5_hr - 1 },
      { min: row.hrz_5_hr, max: top - 1 },
      { min: top, max: top + 20 },
    ];
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const source = req.nextUrl.searchParams.get("source");

  if (source === "garmin") {
    const config = loadGarminConfig();
    if (!config) return NextResponse.json({ error: "Garmin DB not configured" }, { status: 404 });
    const zones = garminZonesFromActivity(config.dbPath);
    if (!zones) return NextResponse.json({ error: "No HR zone data found in recent Garmin activities" }, { status: 404 });
    return NextResponse.json({ zones });
  }

  if (source === "strava") {
    const tokenResult = await getFreshStravaToken();
    if (!tokenResult.ok) return NextResponse.json({ error: "Strava not connected — connect it in Settings first" }, { status: 404 });
    try {
      const z = await getAthleteZones(tokenResult.token);
      const bounds = z.heart_rate?.zones;
      if (!bounds?.length) return NextResponse.json({ error: "No HR zones set on your Strava account" }, { status: 404 });
      const zones: HRZone[] = bounds.map((b, i) => ({
        min: b.min,
        max: b.max > 0 ? b.max : (bounds[i - 1]?.max ?? b.min) + 20,
      }));
      return NextResponse.json({ zones });
    } catch {
      return NextResponse.json({ error: "Failed to fetch Strava zones" }, { status: 502 });
    }
  }

  return NextResponse.json({ error: "source must be 'garmin' or 'strava'" }, { status: 400 });
}
