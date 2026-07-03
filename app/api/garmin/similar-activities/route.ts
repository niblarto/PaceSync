import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadGarminConfig } from "@/lib/garmin-config";
import { garminCacheGet, garminCacheSet } from "@/lib/garmin-cache";
import path from "path";

// Past runs whose distance falls between a scheduled workout's distance and
// +0.5 miles — used by the Runna Schedule card to offer recent routes that
// fit the session.

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const distanceMi = parseFloat(req.nextUrl.searchParams.get("distanceMi") ?? "");
  if (!distanceMi || distanceMi <= 0) {
    return NextResponse.json({ error: "distanceMi required" }, { status: 400 });
  }
  const offset = Math.max(0, parseInt(req.nextUrl.searchParams.get("offset") ?? "0") || 0);

  const config = loadGarminConfig();
  if (!config) return NextResponse.json({ error: "Garmin DB not configured" }, { status: 404 });

  const cacheKey = `similar-activities-${distanceMi.toFixed(2)}-${offset}`;
  const cached = garminCacheGet<object>(cacheKey, config.dbPath);
  if (cached) return NextResponse.json(cached);

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(path.join(config.dbPath, "garmin_activities.db"), {
      readonly: true,
      fileMustExist: true,
    });
    db.pragma("busy_timeout = 30000");

    const rows = db.prepare(`
      SELECT activity_id, name, start_time, distance, elapsed_time, avg_hr
      FROM activities
      WHERE LOWER(sport) LIKE '%running%'
        AND distance >= ?
        AND distance <= ?
      ORDER BY start_time DESC
      LIMIT 3 OFFSET ?
    `).all(distanceMi, distanceMi + 0.5, offset);

    const total = (db.prepare(`
      SELECT COUNT(*) AS n FROM activities
      WHERE LOWER(sport) LIKE '%running%' AND distance >= ? AND distance <= ?
    `).get(distanceMi, distanceMi + 0.5) as { n: number }).n;

    db.close();
    const result = { activities: rows, total, offset };
    garminCacheSet(cacheKey, config.dbPath, result);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
