import { getDb } from "@/lib/db";

// A previously-run Garmin activity pinned to a scheduled workout date+title,
// so the same route can be quickly reselected from the Runna Schedule card
// instead of hunting through "Runs at the distance" again. Unlike pinned AI
// DJ mixes, a route pin isn't consumed by any nightly job — it's kept
// indefinitely (well past the mix's 7-day window) since it's just a saved
// reference, not something a cron re-applies.

const RETAIN_DAYS = 120;

export interface PinnedRoute {
  date: string;         // workout date YYYY-MM-DD
  workoutTitle: string; // the Runna workout this route is pinned to
  activityId: string;   // GarminDB activity_id
  name: string;
  distanceMi: number;
  runDate: string;      // the pinned run's own date, e.g. "12 July 2026"
  pinnedAt: string;     // ISO timestamp
  /** Set when this route was pinned via "Link existing Pace Pro mix…"
      (Runna schedule card, race workouts) — lets the route map recover
      that mix's own tracklist when no separate AI DJ mix is pinned to the
      same workout date (see RunnaCard.tsx's route-map open handlers). */
  paceProMixId: string | null;
}

interface Row {
  date: string;
  workout_title: string;
  activity_id: string;
  name: string;
  distance_mi: number;
  run_date: string;
  pinned_at: string;
  pace_pro_mix_id: string | null;
}

function rowToRoute(r: Row): PinnedRoute {
  return {
    date: r.date, workoutTitle: r.workout_title, activityId: r.activity_id,
    name: r.name, distanceMi: r.distance_mi, runDate: r.run_date, pinnedAt: r.pinned_at,
    paceProMixId: r.pace_pro_mix_id,
  };
}

function pruneOld(): void {
  const cutoffIso = new Date(Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  getDb().prepare("DELETE FROM pinned_routes WHERE date < ?").run(cutoffIso);
}

export function getPinnedRoute(date: string, title: string): PinnedRoute | null {
  const row = getDb().prepare("SELECT * FROM pinned_routes WHERE date = ? AND workout_title = ?").get(date, title) as Row | undefined;
  return row ? rowToRoute(row) : null;
}

// paceProMixId is optional on the input (defaults to null, i.e. "not
// linked from a Pace Pro mix") — every existing caller (the Runna card's
// own "pin this run's route" buttons) keeps working unchanged.
export function setPinnedRoute(entry: Omit<PinnedRoute, "paceProMixId"> & { paceProMixId?: string | null }): void {
  getDb().prepare(
    "INSERT INTO pinned_routes (date, workout_title, activity_id, name, distance_mi, run_date, pinned_at, pace_pro_mix_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(date, workout_title) DO UPDATE SET activity_id = excluded.activity_id, name = excluded.name, distance_mi = excluded.distance_mi, run_date = excluded.run_date, pinned_at = excluded.pinned_at, pace_pro_mix_id = excluded.pace_pro_mix_id"
  ).run(entry.date, entry.workoutTitle, entry.activityId, entry.name, entry.distanceMi, entry.runDate, entry.pinnedAt, entry.paceProMixId ?? null);
  pruneOld();
}

export function removePinnedRoute(date: string, title: string): void {
  getDb().prepare("DELETE FROM pinned_routes WHERE date = ? AND workout_title = ?").run(date, title);
}
