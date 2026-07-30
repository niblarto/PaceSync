import fs from "fs";
import path from "path";
import { workoutKey } from "@/lib/workout-key";

// Pace Pro-style per-mile race splits, pasted in by the user (copied from a
// race-pacing tool as tab-separated rows: split #, split distance, split
// pace, cumulative distance, cumulative avg pace, elevation change) and
// attached to a specific race in the Runna schedule. Persisted the same way
// as lib/pinned-routes.ts — keyed by workout date+title (see
// lib/workout-key.ts), retained well past the race itself so it's still
// visible for review afterward.

const FILE = path.join(process.cwd(), "race-splits.json");
const RETAIN_DAYS = 180;

export interface RaceSplit {
  splitNum: number;
  splitMi: number;
  splitPaceSec: number;      // seconds per mile
  cumulativeMi: number;
  cumulativePaceSec: number; // seconds per mile
  elevationChangeM: number;  // signed, e.g. -2 or +54
}

export interface RaceSplitsEntry {
  date: string;         // workout date YYYY-MM-DD
  workoutTitle: string;
  splits: RaceSplit[];
  savedAt: string;       // ISO timestamp
}

function loadAll(): Record<string, RaceSplitsEntry> {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8")) as Record<string, RaceSplitsEntry>;
  } catch {
    return {};
  }
}

function saveAll(all: Record<string, RaceSplitsEntry>): void {
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
  Object.entries(all).forEach(([key, e]) => {
    if (new Date(e.date + "T12:00:00").getTime() < cutoff) delete all[key];
  });
  fs.writeFileSync(FILE, JSON.stringify(all), "utf-8");
}

export function getRaceSplits(date: string, title: string): RaceSplitsEntry | null {
  return loadAll()[workoutKey(date, title)] ?? null;
}

export function setRaceSplits(entry: RaceSplitsEntry): void {
  const all = loadAll();
  all[workoutKey(entry.date, entry.workoutTitle)] = entry;
  saveAll(all);
}

export function removeRaceSplits(date: string, title: string): void {
  const all = loadAll();
  delete all[workoutKey(date, title)];
  saveAll(all);
}

// "7:57" or "7:57 /mi" -> 477 (seconds per mile).
function parsePaceToSec(text: string): number | null {
  const m = text.match(/(\d+):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// "1.72 mi" -> 1.72
function parseMiles(text: string): number | null {
  const m = text.match(/([\d.]+)\s*mi/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return isNaN(n) ? null : n;
}

// "- 2 m" / "+ 54 m" / "-2m" -> -2 / 54
function parseElevation(text: string): number | null {
  const m = text.match(/([+-])\s*(\d+)\s*m/i);
  if (!m) return null;
  const n = parseInt(m[2], 10);
  return m[1] === "-" ? -n : n;
}

export type ParsePastedSplitsResult =
  | { ok: true; splits: RaceSplit[] }
  | { ok: false; error: string };

// Parses Pace Pro's copy-paste split table. Each row: split #, split
// distance, split pace, cumulative distance, cumulative avg pace, elevation
// change — tab-separated (as copied from the source table) or separated by
// runs of 2+ spaces (in case the paste loses literal tabs). Any row that
// doesn't match all 6 fields is reported by its 1-based row number rather
// than silently skipped, so a bad paste is easy to fix and re-submit.
export function parsePastedSplits(text: string): ParsePastedSplitsResult {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return { ok: false, error: "No rows found in the pasted text." };

  const splits: RaceSplit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].split(/\t+/).map(c => c.trim()).filter(Boolean);
    // Fall back to splitting on 2+ spaces if there were no real tabs.
    const fields = cols.length >= 6 ? cols : lines[i].split(/\s{2,}/).map(c => c.trim()).filter(Boolean);
    if (fields.length < 6) {
      return { ok: false, error: `Row ${i + 1} doesn't have 6 columns: "${lines[i]}"` };
    }

    const splitNum = parseInt(fields[0], 10);
    const splitMi = parseMiles(fields[1]);
    const splitPaceSec = parsePaceToSec(fields[2]);
    const cumulativeMi = parseMiles(fields[3]);
    const cumulativePaceSec = parsePaceToSec(fields[4]);
    const elevationChangeM = parseElevation(fields[5]);

    if (
      isNaN(splitNum) || splitMi == null || splitPaceSec == null
      || cumulativeMi == null || cumulativePaceSec == null || elevationChangeM == null
    ) {
      return { ok: false, error: `Row ${i + 1} couldn't be parsed: "${lines[i]}"` };
    }

    splits.push({ splitNum, splitMi, splitPaceSec, cumulativeMi, cumulativePaceSec, elevationChangeM });
  }

  return { ok: true, splits };
}
