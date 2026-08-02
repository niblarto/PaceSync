import { getDb } from "@/lib/db";

// Tracks explicitly "removed from mix" (ejected, but kept in the library —
// see components/DashboardClient.tsx's removeTrackFromMix) for a workout's
// CURRENT mix-building session. Persisted so the exclusion survives a page
// reload — previously this lived only in browser memory and a reload
// silently dropped it, letting "Fill the gap"/"Remix" pick an ejected track
// straight back in. Cleared whenever a fresh build/remix starts (a new
// session), same lifecycle as the in-memory state it backs.

const RETAIN_DAYS = 30;

export interface RemovedTracksEntry {
  date: string;         // workout date YYYY-MM-DD
  workoutTitle: string;
  uris: string[];
  updatedAt: string;    // ISO timestamp
}

interface Row {
  date: string;
  workout_title: string;
  uris_json: string;
  updated_at: string;
}

function rowToEntry(r: Row): RemovedTracksEntry {
  return { date: r.date, workoutTitle: r.workout_title, uris: JSON.parse(r.uris_json) as string[], updatedAt: r.updated_at };
}

function pruneOld(): void {
  const cutoffIso = new Date(Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  getDb().prepare("DELETE FROM removed_tracks WHERE date < ?").run(cutoffIso);
}

export function getRemovedTracks(date: string, title: string): string[] {
  const row = getDb().prepare("SELECT * FROM removed_tracks WHERE date = ? AND workout_title = ?").get(date, title) as Row | undefined;
  return row ? rowToEntry(row).uris : [];
}

export function addRemovedTrack(date: string, title: string, uri: string): void {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM removed_tracks WHERE date = ? AND workout_title = ?").get(date, title) as Row | undefined;
  const uris = existing ? Array.from(new Set([...(JSON.parse(existing.uris_json) as string[]), uri])) : [uri];
  db.prepare(
    "INSERT INTO removed_tracks (date, workout_title, uris_json, updated_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(date, workout_title) DO UPDATE SET uris_json = excluded.uris_json, updated_at = excluded.updated_at"
  ).run(date, title, JSON.stringify(uris), new Date().toISOString());
  pruneOld();
}

export function clearRemovedTracks(date: string, title: string): void {
  getDb().prepare("DELETE FROM removed_tracks WHERE date = ? AND workout_title = ?").run(date, title);
}
