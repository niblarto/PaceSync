import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSavedPaceProMix } from "@/lib/pace-pro-saved";
import { parsePaceProCsv, paceProSplitsToRaceSplits } from "@/lib/pace-pro";
import { setRaceSplits, type RaceSplitsEntry } from "@/lib/race-splits";
import { setPinnedRoute } from "@/lib/pinned-routes";
import { loadGarminConfig } from "@/lib/garmin-config";
import path from "path";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// "Link existing Pace Pro mix…" on the Runna schedule card's race workouts
// — reuses a saved Pace Pro library entry's splits (converted from its
// 3-column Pace Pro shape to the race card's 6-column shape — see
// lib/pace-pro.ts's paceProSplitsToRaceSplits, elevation always 0 since
// Pace Pro exports don't carry it) instead of re-pasting or re-scanning a
// screenshot for a race you've already planned before. If the saved mix
// also has a GarminDB route attached, that gets pinned onto this workout
// date too, in the same call — one action covers both halves of "link a
// Pace Pro tracklist/route from the library" instead of two separate ones.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { date?: string; workoutTitle?: string; mixId?: string };
  if (!body.date || !DATE_RE.test(body.date) || !body.workoutTitle || !body.mixId) {
    return NextResponse.json({ error: "date, workoutTitle, and mixId required" }, { status: 400 });
  }

  const mix = getSavedPaceProMix(body.mixId);
  if (!mix) return NextResponse.json({ error: "Saved Pace Pro mix not found" }, { status: 404 });

  const parsed = parsePaceProCsv(mix.splitsCsvText);
  if (!parsed.ok) return NextResponse.json({ error: `Could not parse this mix's splits: ${parsed.error}` }, { status: 400 });

  const entry: RaceSplitsEntry = {
    date: body.date,
    workoutTitle: body.workoutTitle,
    splits: paceProSplitsToRaceSplits(parsed.splits),
    savedAt: new Date().toISOString(),
  };
  setRaceSplits(entry);

  let routeLinked = false;
  if (mix.activityId) {
    const config = loadGarminConfig();
    if (config) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Database = require("better-sqlite3") as typeof import("better-sqlite3");
        const db = new Database(path.join(config.dbPath, "garmin_activities.db"), { readonly: true, fileMustExist: true });
        db.pragma("busy_timeout = 30000");
        const row = db.prepare(
          "SELECT activity_id, name, start_time, distance FROM activities WHERE activity_id = ?",
        ).get(mix.activityId) as { activity_id: string | number; name: string | null; start_time: string; distance: number | null } | undefined;
        db.close();
        if (row) {
          // Every OTHER "pin this run's route" path writes runDate as the
          // short "25 Jul" form (see components/RunnaCard.tsx's own
          // routeDate() helper) — this was writing the raw GarminDB
          // start_time straight through instead (confirmed:
          // "2025-09-28 09:35:10.000000" showing up unformatted in the
          // Pinned route label).
          const runDate = new Date(row.start_time.slice(0, 19).replace(" ", "T"))
            .toLocaleDateString("en-GB", { day: "numeric", month: "short" });
          setPinnedRoute({
            date: body.date,
            workoutTitle: body.workoutTitle,
            activityId: String(row.activity_id),
            name: row.name ?? "",
            distanceMi: row.distance ?? 0,
            runDate,
            pinnedAt: new Date().toISOString(),
            paceProMixId: mix.id,
          });
          routeLinked = true;
        }
      } catch { /* best-effort — the splits link above already succeeded regardless */ }
    }
  }

  return NextResponse.json({ ok: true, splits: entry, routeLinked });
}
