import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadGarminConfig } from "@/lib/garmin-config";
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

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const config = loadGarminConfig();
  if (!config) {
    return NextResponse.json({ error: "Garmin DB not configured" }, { status: 404 });
  }

  const base = config.dbPath;

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
    );

    const weekly = queryDb(
      path.join(base, "garmin_summary.db"),
      `SELECT first_day, steps, sleep_avg, rhr_avg, stress_avg, activities
       FROM weeks_summary
       ORDER BY first_day DESC LIMIT 12`
    );

    return NextResponse.json({ daily, sleep, activities, weekly });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `DB query failed: ${msg}` }, { status: 500 });
  }
}
