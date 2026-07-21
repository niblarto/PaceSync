import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadGarminConfig } from "@/lib/garmin-config";
import { garminCacheGet, garminCacheSet } from "@/lib/garmin-cache";
import path from "path";

// GPS track for one activity, downsampled for drawing a route polyline.
// Each point is [lat, lng, speedMph|null, elapsedSec|null, cumulativeMi].

const MAX_POINTS = 600;
const EARTH_RADIUS_MI = 3958.8;

function haversineMi(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_MI * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const config = loadGarminConfig();
  if (!config) return NextResponse.json({ error: "Garmin DB not configured" }, { status: 404 });

  const id = params.id;
  const cacheKey = `route-${id}`;
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
      SELECT position_lat AS lat, position_long AS lng, speed, timestamp
      FROM activity_records
      WHERE activity_id = ? AND position_lat IS NOT NULL AND position_long IS NOT NULL
      ORDER BY record
    `).all(id) as { lat: number; lng: number; speed: number | null; timestamp: string }[];

    const meta = db.prepare(`SELECT name, distance, elapsed_time, start_time FROM activities WHERE activity_id = ?`).get(id) as
      { name?: string; distance?: number; elapsed_time?: string | number; start_time?: string } | undefined;
    db.close();

    if (rows.length === 0) {
      return NextResponse.json({ error: "No GPS data for this activity" }, { status: 404 });
    }

    // Elapsed seconds from the run's start, per point (kept for the pace-
    // quartile fallback colouring) — the workout-section overlay itself
    // buckets by cumulative distance instead (see cumMi below), since Runna
    // workouts are distance-based and a pacing variance shouldn't
    // shrink/stretch which points count as "warm up" vs "work".
    const startMs = meta?.start_time ? new Date(meta.start_time.replace(" ", "T")).getTime() : NaN;
    const elapsedSec = (ts: string) => {
      if (isNaN(startMs)) return null;
      const t = new Date(ts.replace(" ", "T")).getTime();
      return isNaN(t) ? null : (t - startMs) / 1000;
    };

    // Cumulative distance at full GPS resolution (downsampling first would
    // undercount — it skips points, cutting corners on turns).
    let cumMi = 0;
    const cumAtFullRes: number[] = [0];
    for (let i = 1; i < rows.length; i++) {
      cumMi += haversineMi(rows[i - 1].lat, rows[i - 1].lng, rows[i].lat, rows[i].lng);
      cumAtFullRes.push(cumMi);
    }

    // Downsample evenly, always keeping the final point so the loop closes.
    const step = Math.max(1, Math.ceil(rows.length / MAX_POINTS));
    const points: [number, number, number | null, number | null, number][] = [];
    for (let i = 0; i < rows.length; i += step) {
      points.push([rows[i].lat, rows[i].lng, rows[i].speed, elapsedSec(rows[i].timestamp), cumAtFullRes[i]]);
    }
    const last = rows[rows.length - 1];
    const tail = points[points.length - 1];
    if (tail[0] !== last.lat || tail[1] !== last.lng) {
      points.push([last.lat, last.lng, last.speed, elapsedSec(last.timestamp), cumAtFullRes[cumAtFullRes.length - 1]]);
    }

    const result = {
      name: meta?.name ?? null,
      distance: meta?.distance ?? null,
      elapsedTime: meta?.elapsed_time ?? null,
      points,
    };
    garminCacheSet(cacheKey, config.dbPath, result);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
