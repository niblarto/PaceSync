import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadGarminConfig } from "@/lib/garmin-config";
import { garminCacheGet, garminCacheSet } from "@/lib/garmin-cache";
import { getActivityTitleOverride } from "@/lib/garmin-activity-titles";
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

function queryDbOne(dbPath: string, sql: string, params: unknown[] = []) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 30000");
  try {
    return db.prepare(sql).get(...params) ?? null;
  } finally {
    db.close();
  }
}

// Speed stored in mph → pace in secs/mile
function speedToPace(mph: number): number | null {
  if (!mph || mph < 0.5) return null;
  return Math.round(3600 / mph);
}

function parseGarminTs(ts: string): number {
  return new Date(ts.slice(0, 19).replace(" ", "T")).getTime();
}

const BUCKET_SECS = 10;

interface RawRecord {
  record: number;
  timestamp: string;
  cadence: number | null;
  hr: number | null;
  speed: number | null;
}

interface ChartPoint {
  t: number;
  pace: number | null;
  cadence: number | null;
  hr: number | null;
  // Cumulative distance (miles) at the END of this 10s bucket — integrated
  // from each raw record's own speed × time-delta before bucketing, since
  // activity_records carries no distance column of its own (unlike
  // activity_laps, which only has one cumulative total per LAP, too coarse
  // for a per-10s chart point). Lets a client overlay a per-MILE target
  // (e.g. a Pace Pro plan's split paces) against this time-based chart by
  // looking up which split each point's distance falls into.
  distanceMi: number;
}

function buildChartData(rawRecords: RawRecord[]): ChartPoint[] {
  if (!rawRecords.length) return [];

  const t0 = parseGarminTs(rawRecords[0].timestamp);

  const buckets = new Map<number, { paces: number[]; cadences: number[]; hrs: number[]; distanceMi: number }>();

  let cumulativeMi = 0;
  let prevMs = t0;
  for (const r of rawRecords) {
    const nowMs = parseGarminTs(r.timestamp);
    const dtHours = Math.max(0, nowMs - prevMs) / 3_600_000;
    // Integrate BEFORE advancing prevMs, using this record's own speed for
    // the interval since the previous record — same "speed × elapsed"
    // convention run-pacing's own pace-vs-actual comparison already uses.
    cumulativeMi += (r.speed ?? 0) * dtHours;
    prevMs = nowMs;

    const elapsed = Math.round((nowMs - t0) / 1000);
    const b = Math.floor(elapsed / BUCKET_SECS);
    if (!buckets.has(b)) buckets.set(b, { paces: [], cadences: [], hrs: [], distanceMi: 0 });
    const bucket = buckets.get(b)!;
    const pace = speedToPace(r.speed ?? 0);
    if (pace !== null) bucket.paces.push(pace);
    if (r.cadence && r.cadence > 10) bucket.cadences.push(r.cadence * 2);
    if (r.hr && r.hr > 30) bucket.hrs.push(r.hr);
    // Last record in the bucket wins — cumulative distance at the bucket's
    // own end point, not an average (distance only ever increases).
    bucket.distanceMi = cumulativeMi;
  }

  const avg = (arr: number[]) =>
    arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null;

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([b, { paces, cadences, hrs, distanceMi }]) => ({
      t: b * BUCKET_SECS,
      pace: avg(paces),
      cadence: avg(cadences),
      hr: avg(hrs),
      distanceMi: Math.round(distanceMi * 1000) / 1000,
    }));
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const config = loadGarminConfig();
  if (!config) return NextResponse.json({ error: "Garmin DB not configured" }, { status: 404 });

  const base = config.dbPath;
  const actDb = path.join(base, "garmin_activities.db");
  const id = params.id;

  // Title override (garmin_activity_titles) is applied fresh on every
  // response, cached or not — see /api/garmin/data's applyTitleOverrides
  // for why (the in-process cache here invalidates only on GarminDB's own
  // mtime change, so an edit wouldn't show until the next sync otherwise).
  const titleOverride = getActivityTitleOverride(id);
  const withTitleOverride = <T extends { activity?: { name?: string | null } | null }>(result: T): T =>
    titleOverride && result.activity ? { ...result, activity: { ...result.activity, name: titleOverride } } : result;

  const cached = garminCacheGet<{ activity?: { name?: string | null } | null }>(`activity-${id}`, base);
  if (cached) return NextResponse.json(withTitleOverride(cached));

  try {
    const activity = queryDbOne(actDb,
      `SELECT * FROM activities WHERE activity_id = ?`, [id]) as { name?: string | null } | null;

    if (!activity) return NextResponse.json({ error: "Activity not found" }, { status: 404 });

    const laps = queryDb(actDb,
      `SELECT lap, start_time, elapsed_time, moving_time, distance,
              avg_hr, max_hr, avg_cadence, avg_speed, ascent, calories,
              hrz_1_time, hrz_2_time, hrz_3_time, hrz_4_time, hrz_5_time
       FROM activity_laps WHERE activity_id = ? ORDER BY lap`, [id]);

    const steps = queryDbOne(actDb,
      `SELECT steps, avg_pace, avg_moving_pace, max_pace,
              avg_steps_per_min, max_steps_per_min, avg_step_length, vo2_max
       FROM steps_activities WHERE activity_id = ?`, [id]);

    const rawRecords = queryDb(actDb,
      `SELECT record, timestamp, cadence, hr, speed
       FROM activity_records WHERE activity_id = ? ORDER BY record`, [id]) as RawRecord[];

    const records = buildChartData(rawRecords);

    const recordsT0 = rawRecords.length ? rawRecords[0].timestamp : null;
    // Cache the RAW activity (no override baked in), same reasoning as
    // /api/garmin/data.
    const result = { activity, laps, steps, records, recordsT0 };
    garminCacheSet(`activity-${id}`, base, result);
    return NextResponse.json(withTitleOverride(result));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `DB query failed: ${msg}` }, { status: 500 });
  }
}
