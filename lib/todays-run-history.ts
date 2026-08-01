import fs from "fs";
import path from "path";
import type { AiDjMixResponse } from "@/lib/ai-dj-mix";
import { workoutKey } from "@/lib/workout-key";
import { applyBpmOverrides } from "@/lib/bpm-track-overrides";

// Snapshot of what the "Today's Run" playlist held for each workout date, so
// past runs can be reviewed song-by-song against the pace actually run
// (via GarminDB). Keyed by workout date+title (see lib/workout-key.ts — date
// alone collides when Runna reuses a workout title on a different week, or a
// day has more than one workout slot), pruned to the last 90 days.

const FILE = path.join(process.cwd(), "todays-run-history.json");
const RETAIN_DAYS = 90;

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

function loadAll(): Record<string, TodaysRunEntry> {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8")) as Record<string, TodaysRunEntry>;
  } catch {
    return {};
  }
}

export function saveTodaysRunEntry(entry: TodaysRunEntry): void {
  try {
    const all = loadAll();
    all[workoutKey(entry.date, entry.workoutTitle)] = entry;
    const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
    Object.entries(all).forEach(([key, e]) => {
      if (new Date(e.date + "T12:00:00").getTime() < cutoff) delete all[key];
    });
    fs.writeFileSync(FILE, JSON.stringify(all), "utf-8");
  } catch (e) {
    console.warn("[todays-run-history] save failed:", e);
  }
}

export function getTodaysRunEntry(date: string, title: string): TodaysRunEntry | null {
  return loadAll()[workoutKey(date, title)] ?? null;
}

// Same trailing window the Runna summary card shows completed runs in
// (lib/runna-schedule.ts's parseIcs: today back 8 days) — a run still
// inside this window is still "on the card" and its saved tracklist is a
// record of what actually played, not something an automatic cascade
// should be able to silently wipe. Deliberate user actions (explicit
// "unpin"/"delete saved mix" clicks) are NOT gated by this — only the
// automatic track-delete cascade (app/api/tracks/delete) opts in via
// protectRecentRuns, since that's the one path that can remove a run's
// tracklist as an unintended side effect of an unrelated action.
const SUMMARY_CARD_LOOKBACK_DAYS = 8;

export function isWithinRunnaSummaryWindow(date: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  const lookback = new Date(Date.now() - SUMMARY_CARD_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return date >= lookback && date <= today;
}

export function removeTodaysRunEntry(date: string, title: string, opts?: { protectRecentRuns?: boolean }): void {
  try {
    if (opts?.protectRecentRuns && isWithinRunnaSummaryWindow(date)) return;
    const all = loadAll();
    const key = workoutKey(date, title);
    if (!(key in all)) return;
    delete all[key];
    fs.writeFileSync(FILE, JSON.stringify(all), "utf-8");
  } catch (e) {
    console.warn("[todays-run-history] remove failed:", e);
  }
}

// Record whether the saved mix was actually what played that day. Doesn't
// remove the entry — just marks it so pacing review and getPlayedTracks()
// can exclude it without losing the record.
export function setTodaysRunApproval(date: string, title: string, approved: boolean): TodaysRunEntry | null {
  const all = loadAll();
  const key = workoutKey(date, title);
  const entry = all[key];
  if (!entry) return null;
  entry.approved = approved;
  fs.writeFileSync(FILE, JSON.stringify(all), "utf-8");
  return entry;
}

export function getAllTodaysRunEntries(): TodaysRunEntry[] {
  return Object.values(loadAll()).sort((a, b) => b.date.localeCompare(a.date));
}

// How many confirmed (not disputed) "Today's Run" mixes each track has
// featured in — one count per date, not per song-in-that-mix, so a track
// repeated within the same day's mix still only counts once for that day.
export function getPlayedCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  Object.values(loadAll()).forEach(entry => {
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
  Object.values(loadAll()).forEach(entry => {
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
