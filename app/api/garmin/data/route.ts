import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadGarminConfig } from "@/lib/garmin-config";
import { garminCacheGet, garminCacheSet } from "@/lib/garmin-cache";
import { getActivityTitleOverrides } from "@/lib/garmin-activity-titles";
import path from "path";

function queryDb(dbPath: string, sql: string, params: unknown[] = []) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 30000");
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

interface ActivityRow {
  activity_id: string | number;
  name: string | null;
  [key: string]: unknown;
}

// Applies garmin_activity_titles overrides on top of GarminDB's own
// `name` — done on EVERY response (cached or freshly queried), not baked
// into what garminCacheSet stores: the in-process cache invalidates only
// when garmin_activities.db's own mtime changes (lib/garmin-cache.ts), so
// a title edit saved via /api/garmin/activity-title would otherwise not
// show up until the next Garmin sync rewrote that file.
function applyTitleOverrides(activities: ActivityRow[]): ActivityRow[] {
  const overrides = getActivityTitleOverrides(activities.map(a => String(a.activity_id)));
  if (overrides.size === 0) return activities;
  return activities.map(a => {
    const override = overrides.get(String(a.activity_id));
    return override ? { ...a, name: override } : a;
  });
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const config = loadGarminConfig();
  if (!config) {
    return NextResponse.json({ error: "Garmin DB not configured" }, { status: 404 });
  }

  const base = config.dbPath;

  const cached = garminCacheGet<{ activities: ActivityRow[] } & Record<string, unknown>>("data", base);
  if (cached) return NextResponse.json({ ...cached, activities: applyTitleOverrides(cached.activities) });

  try {
    const daily = queryDb(
      path.join(base, "garmin.db"),
      `SELECT day, steps, rhr, stress_avg, calories_active, distance
       FROM daily_summary
       ORDER BY day DESC LIMIT 30`
    );

    const sleep = queryDb(
      path.join(base, "garmin.db"),
      `SELECT day, total_sleep, deep_sleep, light_sleep, rem_sleep, score, qualifier
       FROM sleep
       ORDER BY day DESC LIMIT 14`
    );

    const activities = queryDb(
      path.join(base, "garmin_activities.db"),
      `SELECT activity_id, name, sport, sub_sport, start_time,
              distance, elapsed_time, avg_hr, max_hr, calories
       FROM activities
       ORDER BY start_time DESC`
    ) as ActivityRow[];

    const weekly = queryDb(
      path.join(base, "garmin_summary.db"),
      `SELECT first_day, steps, sleep_avg, rhr_avg, stress_avg, activities
       FROM weeks_summary
       ORDER BY first_day DESC LIMIT 12`
    );

    // Cache the RAW GarminDB data (no overrides baked in) so the cache's
    // mtime-based invalidation stays meaningful for the actual DB reads —
    // overrides are applied fresh on every response instead, see
    // applyTitleOverrides's own comment.
    const result = { daily, sleep, activities, weekly };
    garminCacheSet("data", base, result);
    return NextResponse.json({ ...result, activities: applyTitleOverrides(activities) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `DB query failed: ${msg}` }, { status: 500 });
  }
}
