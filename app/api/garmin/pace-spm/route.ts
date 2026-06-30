import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadGarminConfig } from "@/lib/garmin-config";
import { garminCacheGet, garminCacheSet } from "@/lib/garmin-cache";
import path from "path";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const config = loadGarminConfig();
  if (!config) return NextResponse.json({ error: "Garmin DB not configured" }, { status: 404 });

  const cached = garminCacheGet<object[]>("pace-spm", config.dbPath);
  if (cached) return NextResponse.json(cached);

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(path.join(config.dbPath, "garmin_activities.db"), {
      readonly: true,
      fileMustExist: true,
    });
    db.pragma("busy_timeout = 30000");

    // Aggregate per-second records into 5-second pace buckets.
    // speed is in mph → pace_secs = 3600/speed.
    // cadence is raw (×2 = SPM).
    // Bucket = floor(pace_secs / 5) * 5 covers 6:30–10:00/mile (390–600 secs).
    const rows = db.prepare(`
      SELECT
        (CAST(3600.0 / speed / 5 AS INTEGER)) * 5 AS bucket,
        ROUND(AVG(cadence * 2))                 AS avg_spm,
        COUNT(*)                                 AS records
      FROM activity_records
      WHERE speed > 0.3
        AND speed IS NOT NULL
        AND cadence IS NOT NULL
        AND cadence > 10
      GROUP BY bucket
      HAVING bucket BETWEEN 390 AND 600
      ORDER BY bucket
    `).all() as { bucket: number; avg_spm: number; records: number }[];

    db.close();
    garminCacheSet("pace-spm", config.dbPath, rows);
    return NextResponse.json(rows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
