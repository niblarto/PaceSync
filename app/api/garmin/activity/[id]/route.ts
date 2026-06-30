import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadGarminConfig } from "@/lib/garmin-config";
import { garminCacheGet, garminCacheSet } from "@/lib/garmin-cache";
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
}

function buildChartData(rawRecords: RawRecord[]): ChartPoint[] {
  if (!rawRecords.length) return [];

  const t0 = parseGarminTs(rawRecords[0].timestamp);

  const buckets = new Map<number, { paces: number[]; cadences: number[]; hrs: number[] }>();

  for (const r of rawRecords) {
    const elapsed = Math.round((parseGarminTs(r.timestamp) - t0) / 1000);
    const b = Math.floor(elapsed / BUCKET_SECS);
    if (!buckets.has(b)) buckets.set(b, { paces: [], cadences: [], hrs: [] });
    const bucket = buckets.get(b)!;
    const pace = speedToPace(r.speed ?? 0);
    if (pace !== null) bucket.paces.push(pace);
    if (r.cadence && r.cadence > 10) bucket.cadences.push(r.cadence * 2);
    if (r.hr && r.hr > 30) bucket.hrs.push(r.hr);
  }

  const avg = (arr: number[]) =>
    arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null;

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([b, { paces, cadences, hrs }]) => ({
      t: b * BUCKET_SECS,
      pace: avg(paces),
      cadence: avg(cadences),
      hr: avg(hrs),
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

  const cached = garminCacheGet<object>(`activity-${id}`, base);
  if (cached) return NextResponse.json(cached);

  try {
    const activity = queryDbOne(actDb,
      `SELECT * FROM activities WHERE activity_id = ?`, [id]);

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
    const result = { activity, laps, steps, records, recordsT0 };
    garminCacheSet(`activity-${id}`, base, result);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `DB query failed: ${msg}` }, { status: 500 });
  }
}
