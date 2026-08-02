import { getDb } from "@/lib/db";
import type { AiDjMixResponse } from "@/lib/ai-dj-mix";
import { applyBpmOverrides } from "@/lib/bpm-track-overrides";

// Snapshot of what the "Today's Run" playlist held for each workout date, so
// past runs can be reviewed song-by-song against the pace actually run
// (via GarminDB). Keyed by (date, workout_title) — date alone collides when
// Runna reuses a workout title on a different week, or a day has more than
// one workout slot.
//
// PERMANENT for any run that has already taken place — a tracklist is the
// only record of what actually played on a given run, and once that run has
// happened it can never be regenerated, so it must never be silently
// deleted by an age-based sweep. The only thing pruneOld() is still allowed
// to clean up is a stale row dated in the FUTURE relative to today (a
// pre-built mix for a workout that, for whatever reason, was never run and
// never will be — e.g. the workout was later rescheduled/cancelled) —
// anything with date <= today is untouched, no matter how old.

export interface HistoryTrack {
  uri: string | null;
  name: string;
  artist: string;
  startsAtSec: number;   // offset from the start of the mix
  durationSec: number;
  targetPaceSec: number | null; // sec/mi the segment was built for
  segment: string;
  tempo: number | null; // track BPM, for the saved-mix tracklist display
  energy: number | null; // 0-1 Spotify energy, for the saved-mix tracklist display
}

export interface TodaysRunEntry {
  date: string;          // workout date YYYY-MM-DD
  workoutTitle: string;
  savedAt: string;       // ISO timestamp of the save
  tracks: HistoryTrack[];
  // Set when the user confirms/denies this was the playlist actually run to
  // (e.g. they listened to something else that day). Undefined = not yet
  // reviewed. A disputed entry is excluded from pacing review and from
  // getPlayedTracks() so it can't demote tracks that never really played.
  approved?: boolean;
}

interface Row {
  date: string;
  workout_title: string;
  saved_at: string;
  tracks_json: string;
  approved: number | null;
}

function rowToEntry(r: Row): TodaysRunEntry {
  return {
    date: r.date,
    workoutTitle: r.workout_title,
    savedAt: r.saved_at,
    tracks: JSON.parse(r.tracks_json) as HistoryTrack[],
    approved: r.approved === null ? undefined : !!r.approved,
  };
}

function mmssToSec(v: string): number {
  const p = String(v).split(":").map(Number);
  return p.some(isNaN) ? 0 : p.reduce((acc, x) => acc * 60 + x, 0);
}

export function timelineToHistoryTracks(timeline: AiDjMixResponse["timeline"]): HistoryTrack[] {
  const tracks: HistoryTrack[] = [];
  (timeline ?? []).forEach(seg => {
    (seg.tracks ?? []).forEach(t => {
      tracks.push({
        uri: t.uri ?? null,
        name: t.name,
        artist: t.artist,
        startsAtSec: mmssToSec(t.startsAt),
        durationSec: t.durationSec ?? 0,
        targetPaceSec: seg.targetPaceSec ?? null,
        segment: seg.segment,
        tempo: t.tempo ?? null,
        energy: t.energy ?? null,
      });
    });
  });
  // A saved snapshot should already reflect any persistent BPM correction
  // (lib/bpm-track-overrides.ts) at the moment it's frozen, not just when
  // displayed later — otherwise a mix saved before a nudge would show the
  // stale tempo until something else (e.g. run-pacing's own override merge)
  // corrected it on read.
  return applyBpmOverrides(tracks);
}

export function saveTodaysRunEntry(entry: TodaysRunEntry): void {
  try {
    getDb().prepare(
      "INSERT INTO todays_run_history (date, workout_title, saved_at, tracks_json, approved) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(date, workout_title) DO UPDATE SET saved_at = excluded.saved_at, tracks_json = excluded.tracks_json, approved = excluded.approved"
    ).run(entry.date, entry.workoutTitle, entry.savedAt, JSON.stringify(entry.tracks), entry.approved == null ? null : (entry.approved ? 1 : 0));
  } catch (e) {
    console.warn("[todays-run-history] save failed:", e);
  }
}

export function getTodaysRunEntry(date: string, title: string): TodaysRunEntry | null {
  const row = getDb().prepare("SELECT * FROM todays_run_history WHERE date = ? AND workout_title = ?").get(date, title) as Row | undefined;
  return row ? rowToEntry(row) : null;
}

// Every saved entry for a given date, regardless of title — for callers
// that only know a date (e.g. a plain Garmin activity with no Runna
// workout title attached) and need to discover whatever tracklist(s) exist
// for that day. Most days have exactly one; a day with two workout slots
// (e.g. a run + a strength session) can have more than one.
export function getTodaysRunEntriesForDate(date: string): TodaysRunEntry[] {
  const rows = getDb().prepare("SELECT * FROM todays_run_history WHERE date = ?").all(date) as Row[];
  return rows.map(rowToEntry);
}

// A tracklist for a run that has already happened is a permanent record —
// it is the only surviving evidence of what actually played, and can never
// be regenerated once gone. So removeTodaysRunEntry unconditionally refuses
// to delete any row dated today or earlier, no matter which caller asks —
// the automatic track-delete cascade (app/api/tracks/delete), the explicit
// "Unpin" button (app/api/ai-dj/pin's DELETE handler), and the explicit
// "Delete saved mix" button (app/api/todays-run/history's DELETE handler)
// are all subject to this the same way. Only a row for an upcoming (still
// just-planned) workout can ever be removed.
export function isPastOrToday(date: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  return date <= today;
}

export function removeTodaysRunEntry(date: string, title: string): void {
  try {
    if (isPastOrToday(date)) return;
    getDb().prepare("DELETE FROM todays_run_history WHERE date = ? AND workout_title = ?").run(date, title);
  } catch (e) {
    console.warn("[todays-run-history] remove failed:", e);
  }
}

// Record whether the saved mix was actually what played that day. Doesn't
// remove the entry — just marks it so pacing review and getPlayedTracks()
// can exclude it without losing the record.
export function setTodaysRunApproval(date: string, title: string, approved: boolean): TodaysRunEntry | null {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM todays_run_history WHERE date = ? AND workout_title = ?").get(date, title) as Row | undefined;
  if (!existing) return null;
  db.prepare("UPDATE todays_run_history SET approved = ? WHERE date = ? AND workout_title = ?").run(approved ? 1 : 0, date, title);
  return rowToEntry({ ...existing, approved: approved ? 1 : 0 });
}

export function getAllTodaysRunEntries(): TodaysRunEntry[] {
  const rows = getDb().prepare("SELECT * FROM todays_run_history ORDER BY date DESC").all() as Row[];
  return rows.map(rowToEntry);
}

// How many confirmed (not disputed) "Today's Run" mixes each track has
// featured in — one count per date, not per song-in-that-mix, so a track
// repeated within the same day's mix still only counts once for that day.
export function getPlayedCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  getAllTodaysRunEntries().forEach(entry => {
    if (entry.approved === false) return; // disputed — didn't actually play
    const seenToday = new Set<string>();
    entry.tracks.forEach(t => {
      if (!t.uri || seenToday.has(t.uri)) return;
      seenToday.add(t.uri);
      counts[t.uri] = (counts[t.uri] ?? 0) + 1;
    });
  });
  return counts;
}

// Most recent conversational/easy-pace ceiling actually used to build a
// mix, across saved history (newest date first, since getAllTodaysRunEntries
// already sorts that way) — the fitness-adaptive replacement for a hardcoded
// default: gets quicker as training progresses, drops back if there's a
// lapse (injury, break), because it just reflects whatever Runna's own "no
// faster than X/mi" ceiling most recently said. Undefined when there's no
// history yet (first run ever, or history file missing) — callers fall back
// to DEFAULT_EASY_PACE only in that case.
export function getLastEasyPaceSec(): number | null {
  const entries = getAllTodaysRunEntries();
  for (const entry of entries) {
    if (entry.approved === false) continue; // disputed — not a real reflection of what was run
    for (const t of entry.tracks) {
      if (!t.targetPaceSec) continue;
      const label = t.segment.toLowerCase();
      if (label.includes("conversational") || label.includes("easy") || label.includes("recovery")) {
        return t.targetPaceSec;
      }
    }
  }
  return null;
}

// Tracks that have already featured in a run (entries up to today — a mix
// pre-built for tomorrow hasn't been played yet). Sent to the mix builder so
// played-but-unvoted tracks rank below unplayed ones at the pace band they
// were played at. Deduped by uri+pace.
export function getPlayedTracks(): { uri: string; paceSec: number | null }[] {
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const played: { uri: string; paceSec: number | null }[] = [];
  getAllTodaysRunEntries().forEach(entry => {
    if (entry.date > today) return;
    if (entry.approved === false) return; // disputed — didn't actually play
    entry.tracks.forEach(t => {
      if (!t.uri) return;
      const key = `${t.uri}|${t.targetPaceSec ?? ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      played.push({ uri: t.uri, paceSec: t.targetPaceSec });
    });
  });
  return played;
}
