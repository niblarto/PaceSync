import { getDb } from "@/lib/db";

// Per-segment candidate track pools the AI DJ mixer considered while
// building a workout's mix, kept around so the Runna schedule card can
// let the user browse (and act on, via the main tracklist UI) what the
// mixer actually chose from — not just the final picks. Keyed by workout
// date+title; a fresh mix build for the same workout fully replaces the
// previous entry, it never merges.

const RETAIN_DAYS = 30;

export interface MixCandidatesEntry {
  date: string;         // workout date YYYY-MM-DD
  workoutTitle: string;
  segments: { segment: string; candidateUris: string[] }[]; // index-aligned to the mixed segments array
  savedAt: string;       // ISO timestamp
}

interface Row {
  date: string;
  workout_title: string;
  segments_json: string;
  saved_at: string;
}

function rowToEntry(r: Row): MixCandidatesEntry {
  return { date: r.date, workoutTitle: r.workout_title, segments: JSON.parse(r.segments_json), savedAt: r.saved_at };
}

function pruneOld(): void {
  const cutoffIso = new Date(Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  getDb().prepare("DELETE FROM mix_candidates WHERE date < ?").run(cutoffIso);
}

export function getMixCandidates(date: string, title: string): MixCandidatesEntry | null {
  const row = getDb().prepare("SELECT * FROM mix_candidates WHERE date = ? AND workout_title = ?").get(date, title) as Row | undefined;
  return row ? rowToEntry(row) : null;
}

export function setMixCandidates(entry: MixCandidatesEntry): void {
  getDb().prepare(
    "INSERT INTO mix_candidates (date, workout_title, segments_json, saved_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(date, workout_title) DO UPDATE SET segments_json = excluded.segments_json, saved_at = excluded.saved_at"
  ).run(entry.date, entry.workoutTitle, JSON.stringify(entry.segments), entry.savedAt);
  pruneOld();
}
