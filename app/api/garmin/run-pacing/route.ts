import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadGarminConfig } from "@/lib/garmin-config";
import { garminCacheGet, garminCacheSet } from "@/lib/garmin-cache";
import { getTodaysRunEntry } from "@/lib/todays-run-history";
import { activeCsvPath } from "@/lib/running-playlist-config";
import path from "path";
import fs from "fs";

// URIs currently in the library CSV — tracks deleted since the run played
// are flagged so the UI can strike them through persistently. Computed on
// every request (not cached) so deletions show up immediately everywhere.
function libraryUris(): Set<string> {
  const uris = new Set<string>();
  try {
    const csv = fs.readFileSync(activeCsvPath(), "utf-8");
    csv.split("\n").forEach(line => {
      const uri = line.split(",")[0]?.trim();
      if (uri?.startsWith("spotify:track:")) uris.add(uri);
    });
  } catch { /* no library — leave empty, flag nothing as deleted */ }
  return uris;
}

function withLibraryFlag<T extends { tracks?: { uri: string | null }[] }>(result: T): T {
  if (!result.tracks?.length) return result;
  const lib = libraryUris();
  if (lib.size === 0) return result;
  return {
    ...result,
    tracks: result.tracks.map(t => ({ ...t, inLibrary: t.uri ? lib.has(t.uri) : true })),
  };
}

// Song-by-song pace review for a past run: overlays the "Today's Run" mix
// that was in place for that date onto the run's GarminDB records (assuming
// the playlist started with the run) and grades each song against the pace
// its segment was built for.

// How far off target still counts as "on pace" (sec/mi either side).
const TOLERANCE_SEC_PER_MI = 10;

export interface TrackPacing {
  uri: string | null;
  name: string;
  artist: string;
  segment: string;
  startsAtSec: number;
  durationSec: number;
  targetPaceSec: number | null;
  actualPaceSec: number | null; // null when the run ended before this song
  verdict: "on" | "fast" | "slow" | "unknown";
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date required (YYYY-MM-DD)" }, { status: 400 });
  }

  const entry = getTodaysRunEntry(date);
  if (!entry) return NextResponse.json({ entry: null, tracks: [] });

  const config = loadGarminConfig();
  if (!config) return NextResponse.json({ error: "Garmin DB not configured" }, { status: 404 });

  const cacheKey = `run-pacing-${date}-${entry.savedAt}`;
  const cached = garminCacheGet<{ tracks?: { uri: string | null }[] }>(cacheKey, config.dbPath);
  if (cached) return NextResponse.json(withLibraryFlag(cached));

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(path.join(config.dbPath, "garmin_activities.db"), {
      readonly: true,
      fileMustExist: true,
    });
    db.pragma("busy_timeout = 30000");

    // The day's longest run is taken as the workout the mix was built for.
    const activity = db.prepare(`
      SELECT activity_id, start_time, distance
      FROM activities
      WHERE LOWER(sport) LIKE '%running%' AND DATE(start_time) = ?
      ORDER BY distance DESC
      LIMIT 1
    `).get(date) as { activity_id: string | number; start_time: string; distance: number } | undefined;

    if (!activity) {
      db.close();
      const result = { entry: { workoutTitle: entry.workoutTitle, savedAt: entry.savedAt }, activityId: null, tracks: [] };
      garminCacheSet(cacheKey, config.dbPath, result);
      return NextResponse.json(result);
    }

    const records = db.prepare(`
      SELECT timestamp, speed FROM activity_records
      WHERE activity_id = ? AND speed IS NOT NULL
      ORDER BY timestamp
    `).all(activity.activity_id) as { timestamp: string; speed: number }[];
    db.close();

    const startMs = new Date(activity.start_time.replace(" ", "T")).getTime();
    // Offsets (sec from run start) paired with speed (mph); ignore standing still.
    const samples = records
      .map(r => ({ t: (new Date(r.timestamp.replace(" ", "T")).getTime() - startMs) / 1000, mph: r.speed }))
      .filter(s => !isNaN(s.t) && s.t >= 0);
    const runEndSec = samples.length ? samples[samples.length - 1].t : 0;

    const tracks: TrackPacing[] = entry.tracks.map(t => {
      const end = t.startsAtSec + (t.durationSec || 0);
      // Song windows past the end of the run can't be judged.
      if (!t.durationSec || t.startsAtSec >= runEndSec - 15) {
        return { ...t, actualPaceSec: null, verdict: "unknown" as const };
      }
      const windowEnd = Math.min(end, runEndSec);
      const inWindow = samples.filter(s => s.t >= t.startsAtSec && s.t < windowEnd && s.mph > 0.5);
      if (inWindow.length < 5) {
        return { ...t, actualPaceSec: null, verdict: "unknown" as const };
      }
      const avgMph = inWindow.reduce((a, s) => a + s.mph, 0) / inWindow.length;
      const actualPaceSec = 3600 / avgMph;
      let verdict: TrackPacing["verdict"] = "unknown";
      if (t.targetPaceSec) {
        const diff = actualPaceSec - t.targetPaceSec;
        verdict = Math.abs(diff) <= TOLERANCE_SEC_PER_MI ? "on" : diff < 0 ? "fast" : "slow";
      }
      return { ...t, actualPaceSec, verdict };
    });

    // Overall read: of the judged songs, which way does the run lean?
    const judged = tracks.filter(t => t.verdict === "on" || t.verdict === "fast" || t.verdict === "slow");
    const fast = judged.filter(t => t.verdict === "fast").length;
    const slow = judged.filter(t => t.verdict === "slow").length;
    const summary = judged.length === 0
      ? null
      : fast > judged.length / 2
        ? "Mostly faster than target — consider less intense (slower) mixes at this pace"
        : slow > judged.length / 2
          ? "Mostly slower than target — consider more intense mixes at this pace"
          : "Pacing was broadly on target";

    const result = {
      entry: { workoutTitle: entry.workoutTitle, savedAt: entry.savedAt },
      activityId: activity.activity_id,
      tracks,
      summary,
    };
    garminCacheSet(cacheKey, config.dbPath, result);
    return NextResponse.json(withLibraryFlag(result));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
