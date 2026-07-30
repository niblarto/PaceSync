import fs from "fs";
import path from "path";
import { workoutKey } from "@/lib/workout-key";

// A previously-run Garmin activity pinned to a scheduled workout date+title
// (see lib/workout-key.ts), so the same route can be quickly reselected from
// the Runna Schedule card instead of hunting through "Runs at the distance"
// again. Unlike pinned AI DJ mixes, a route pin isn't consumed by any
// nightly job — it's kept indefinitely (well past the mix's 7-day window)
// since it's just a saved reference, not something a cron re-applies.

const FILE = path.join(process.cwd(), "pinned-routes.json");
const RETAIN_DAYS = 120;

export interface PinnedRoute {
  date: string;         // workout date YYYY-MM-DD
  workoutTitle: string; // the Runna workout this route is pinned to
  activityId: string;   // GarminDB activity_id
  name: string;
  distanceMi: number;
  runDate: string;      // the pinned run's own date, e.g. "12 July 2026"
  pinnedAt: string;     // ISO timestamp
}

function loadAll(): Record<string, PinnedRoute> {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8")) as Record<string, PinnedRoute>;
  } catch {
    return {};
  }
}

function saveAll(all: Record<string, PinnedRoute>): void {
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
  Object.entries(all).forEach(([key, r]) => {
    if (new Date(r.date + "T12:00:00").getTime() < cutoff) delete all[key];
  });
  fs.writeFileSync(FILE, JSON.stringify(all), "utf-8");
}

export function getPinnedRoute(date: string, title: string): PinnedRoute | null {
  return loadAll()[workoutKey(date, title)] ?? null;
}

export function setPinnedRoute(entry: PinnedRoute): void {
  const all = loadAll();
  all[workoutKey(entry.date, entry.workoutTitle)] = entry;
  saveAll(all);
}

export function removePinnedRoute(date: string, title: string): void {
  const all = loadAll();
  delete all[workoutKey(date, title)];
  saveAll(all);
}
