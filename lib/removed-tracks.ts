import fs from "fs";
import path from "path";
import { workoutKey } from "@/lib/workout-key";

// Tracks explicitly "removed from mix" (ejected, but kept in the library —
// see components/DashboardClient.tsx's removeTrackFromMix) for a workout's
// CURRENT mix-building session. Persisted so the exclusion survives a page
// reload — previously this lived only in browser memory and a reload
// silently dropped it, letting "Fill the gap"/"Remix" pick an ejected track
// straight back in. Cleared whenever a fresh build/remix starts (a new
// session), same lifecycle as the in-memory state it backs.

const FILE = path.join(process.cwd(), "removed-tracks.json");
const RETAIN_DAYS = 30;

export interface RemovedTracksEntry {
  date: string;         // workout date YYYY-MM-DD
  workoutTitle: string;
  uris: string[];
  updatedAt: string;    // ISO timestamp
}

function loadAll(): Record<string, RemovedTracksEntry> {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8")) as Record<string, RemovedTracksEntry>;
  } catch {
    return {};
  }
}

function saveAll(all: Record<string, RemovedTracksEntry>): void {
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
  Object.entries(all).forEach(([key, e]) => {
    if (new Date(e.date + "T12:00:00").getTime() < cutoff) delete all[key];
  });
  fs.writeFileSync(FILE, JSON.stringify(all), "utf-8");
}

export function getRemovedTracks(date: string, title: string): string[] {
  return loadAll()[workoutKey(date, title)]?.uris ?? [];
}

export function addRemovedTrack(date: string, title: string, uri: string): void {
  const all = loadAll();
  const key = workoutKey(date, title);
  const existing = all[key];
  const uris = existing ? Array.from(new Set([...existing.uris, uri])) : [uri];
  all[key] = { date, workoutTitle: title, uris, updatedAt: new Date().toISOString() };
  saveAll(all);
}

export function clearRemovedTracks(date: string, title: string): void {
  const all = loadAll();
  delete all[workoutKey(date, title)];
  saveAll(all);
}
