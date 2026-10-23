import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { loadGarminConfig } from "@/lib/garmin-config";
import path from "path";

// Running activities whose recorded GPS passes within ~30 m of a point — the
// Route Finder uses it to show which runs a clicked stretch of route came
// from, so they can be excluded. GET ?lat=&lng=

const RADIUS_M = 30;

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const lat = parseFloat(req.nextUrl.searchParams.get("lat") ?? "");
  const lng = parseFloat(req.nextUrl.searchParams.get("lng") ?? "");
  if (isNaN(lat) || isNaN(lng)) return NextResponse.json({ error: "lat and lng required" }, { status: 400 });

  const config = loadGarminConfig();
  if (!config) return NextResponse.json({ error: "Garmin DB not configured" }, { status: 404 });

  const dLat = RADIUS_M / 110540;
  const dLng = RADIUS_M / (111320 * Math.cos((lat * Math.PI) / 180));

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(path.join(config.dbPath, "garmin_activities.db"), { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 30000");
    const activities = db.prepare(`
      SELECT a.activity_id AS id, a.name, a.start_time AS startTime, a.distance AS distanceMi
      FROM activities a
      WHERE LOWER(a.sport) LIKE '%running%'
        AND a.activity_id IN (
          SELECT DISTINCT activity_id FROM activity_records
          WHERE position_lat BETWEEN ? AND ? AND position_long BETWEEN ? AND ?
        )
      ORDER BY a.start_time DESC
    `).all(lat - dLat, lat + dLat, lng - dLng, lng + dLng);
    db.close();
    return NextResponse.json({ activities });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
