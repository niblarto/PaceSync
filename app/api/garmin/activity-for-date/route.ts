import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadGarminConfig } from "@/lib/garmin-config";
import { getFreshStravaToken, listActivities } from "@/lib/strava";
import path from "path";

// Resolves a workout date to the matching Garmin activity (local DB, for the
// "local Garmin activity" + "Garmin Connect" links) and Strava activity (API
// lookup, for the "Strava" link) on the Runna Summary card. Independent of
// whether an AI DJ mix was ever saved for that date — unlike run-pacing,
// which only looks up an activity when a mix snapshot exists.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function garminActivityForDate(dbPath: string, date: string): { id: string | number } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(path.join(dbPath, "garmin_activities.db"), { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 30000");
    // Prefer the day's longest run (same heuristic as run-pacing), but fall
    // back to any activity that day (e.g. strength training) so non-running
    // workouts still get a "Garmin activity" link.
    let row = db.prepare(`
      SELECT activity_id FROM activities
      WHERE LOWER(sport) LIKE '%running%' AND DATE(start_time) = ?
      ORDER BY distance DESC LIMIT 1
    `).get(date) as { activity_id: string | number } | undefined;
    if (!row) {
      row = db.prepare(`
        SELECT activity_id FROM activities
        WHERE DATE(start_time) = ?
        ORDER BY elapsed_time DESC LIMIT 1
      `).get(date) as { activity_id: string | number } | undefined;
    }
    db.close();
    return row ? { id: row.activity_id } : null;
  } catch {
    return null;
  }
}

async function stravaActivityForDate(date: string): Promise<{ id: number } | null> {
  const tokenResult = await getFreshStravaToken();
  if (!tokenResult.ok) return null;
  try {
    // Strava's before/after are epoch seconds (UTC) — pad a day either side
    // of the target date so any timezone offset in start_date_local still
    // falls inside the fetched window, then filter precisely by local date.
    const dayMs = 24 * 60 * 60 * 1000;
    const target = new Date(`${date}T12:00:00Z`).getTime();
    const after = Math.floor((target - dayMs) / 1000);
    const before = Math.floor((target + dayMs) / 1000);
    const activities = await listActivities(tokenResult.token, 30, 1, { before, after });
    const sameDay = activities.filter(a => a.start_date_local.slice(0, 10) === date);
    if (!sameDay.length) return null;
    // Prefer a Run (matches the Garmin/mix-pacing heuristic); fall back to
    // the longest-duration activity of any type for non-running days.
    const runs = sameDay.filter(a => a.sport_type === "Run");
    const pool = runs.length ? runs : sameDay;
    const longest = pool.reduce((a, b) => (b.distance > a.distance || b.moving_time > a.moving_time ? b : a));
    return { id: longest.id };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!DATE_RE.test(date)) return NextResponse.json({ error: "date required (YYYY-MM-DD)" }, { status: 400 });

  const config = loadGarminConfig();
  const garmin = config ? garminActivityForDate(config.dbPath, date) : null;
  const strava = await stravaActivityForDate(date);

  return NextResponse.json({
    garminId: garmin?.id ?? null,
    stravaId: strava?.id ?? null,
  });
}
