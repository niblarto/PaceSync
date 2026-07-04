import fs from "fs";
import path from "path";
import type { AiDjMixResponse } from "@/lib/ai-dj-mix";

// Snapshot of what the "Today's Run" playlist held for each workout date, so
// past runs can be reviewed song-by-song against the pace actually run
// (via GarminDB). Keyed by workout date, pruned to the last 90 days.

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
}

export interface TodaysRunEntry {
  date: string;          // workout date YYYY-MM-DD
  workoutTitle: string;
  savedAt: string;       // ISO timestamp of the save
  tracks: HistoryTrack[];
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
      });
    });
  });
  return tracks;
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
    all[entry.date] = entry;
    const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
    Object.keys(all).forEach(date => {
      if (new Date(date + "T12:00:00").getTime() < cutoff) delete all[date];
    });
    fs.writeFileSync(FILE, JSON.stringify(all), "utf-8");
  } catch (e) {
    console.warn("[todays-run-history] save failed:", e);
  }
}

export function getTodaysRunEntry(date: string): TodaysRunEntry | null {
  return loadAll()[date] ?? null;
}

export function getAllTodaysRunEntries(): TodaysRunEntry[] {
  return Object.values(loadAll()).sort((a, b) => b.date.localeCompare(a.date));
}
