import fs from "fs";
import path from "path";
import { workoutKey } from "@/lib/workout-key";

// Per-segment candidate track pools the AI DJ mixer considered while
// building a workout's mix, kept around so the Runna schedule card can
// let the user browse (and act on, via the main tracklist UI) what the
// mixer actually chose from — not just the final picks. Keyed by workout
// date+title (see lib/workout-key.ts); a fresh mix build for the same
// workout fully replaces the previous entry, it never merges.

const FILE = path.join(process.cwd(), "mix-candidates.json");
const RETAIN_DAYS = 30;

export interface MixCandidatesEntry {
  date: string;         // workout date YYYY-MM-DD
  workoutTitle: string;
  segments: { segment: string; candidateUris: string[] }[]; // index-aligned to the mixed segments array
  savedAt: string;       // ISO timestamp
}

function loadAll(): Record<string, MixCandidatesEntry> {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8")) as Record<string, MixCandidatesEntry>;
  } catch {
    return {};
  }
}

function saveAll(all: Record<string, MixCandidatesEntry>): void {
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
  Object.entries(all).forEach(([key, e]) => {
    if (new Date(e.date + "T12:00:00").getTime() < cutoff) delete all[key];
  });
  fs.writeFileSync(FILE, JSON.stringify(all), "utf-8");
}

export function getMixCandidates(date: string, title: string): MixCandidatesEntry | null {
  return loadAll()[workoutKey(date, title)] ?? null;
}

export function setMixCandidates(entry: MixCandidatesEntry): void {
  const all = loadAll();
  all[workoutKey(entry.date, entry.workoutTitle)] = entry;
  saveAll(all);
}
