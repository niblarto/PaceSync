import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadGarminConfig } from "@/lib/garmin-config";
import { loadRouteExcluded, saveRouteExcluded } from "@/lib/route-excluded";
import path from "path";

// Running activities (for the Route Finder's exclude picker) plus the saved
// list of excluded ids.

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const excluded = loadRouteExcluded();
  const config = loadGarminConfig();
  if (!config) return NextResponse.json({ activities: [], excluded });

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(path.join(config.dbPath, "garmin_activities.db"), { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 30000");
    const activities = db.prepare(`
      SELECT activity_id AS id, name, start_time AS startTime, distance AS distanceMi
      FROM activities
      WHERE LOWER(sport) LIKE '%running%'
      ORDER BY start_time DESC
    `).all();
    db.close();
    return NextResponse.json({ activities, excluded });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { ids?: unknown };
  if (!Array.isArray(body.ids)) return NextResponse.json({ error: "ids array required" }, { status: 400 });
  saveRouteExcluded(body.ids.map(String));
  return NextResponse.json({ ok: true });
}
