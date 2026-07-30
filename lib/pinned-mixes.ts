import fs from "fs";
import path from "path";
import type { AiDjMixResponse } from "@/lib/ai-dj-mix";
import { workoutKey } from "@/lib/workout-key";

// Mixes pinned to a workout date+title (see lib/workout-key.ts) from the
// dashboard. The nightly AI DJ pre-build uses a pinned mix for that workout
// verbatim instead of generating a fresh one. Pruned once the date is more
// than a week past.

const FILE = path.join(process.cwd(), "pinned-mixes.json");
const RETAIN_DAYS = 7;

export interface PinnedMix {
  date: string;           // workout date YYYY-MM-DD
  workoutTitle: string;
  totalSec: number;
  timeline: AiDjMixResponse["timeline"];
  pinnedAt: string;       // ISO timestamp
}

function loadAll(): Record<string, PinnedMix> {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8")) as Record<string, PinnedMix>;
  } catch {
    return {};
  }
}

function saveAll(all: Record<string, PinnedMix>): void {
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
  Object.entries(all).forEach(([key, mix]) => {
    if (new Date(mix.date + "T12:00:00").getTime() < cutoff) delete all[key];
  });
  fs.writeFileSync(FILE, JSON.stringify(all), "utf-8");
}

export function getPinnedMix(date: string, title: string): PinnedMix | null {
  return loadAll()[workoutKey(date, title)] ?? null;
}

export function setPinnedMix(entry: PinnedMix): void {
  const all = loadAll();
  all[workoutKey(entry.date, entry.workoutTitle)] = entry;
  saveAll(all);
}

export function removePinnedMix(date: string, title: string): void {
  const all = loadAll();
  delete all[workoutKey(date, title)];
  saveAll(all);
}

// Unpins every pinned mix that contains any of the given track URIs — used
// when a track is deleted from the library, so a pinned mix can never keep
// pointing at a track that no longer exists, regardless of which mix (if
// any) happens to be loaded in the browser at the time. Returns the
// {date, title} pairs that were unpinned, so callers can also drop their
// history snapshot via removeTodaysRunEntry(date, title) — both stores key
// by the same workoutKey() format, so this pairing is required, not optional.
export function unpinMixesContaining(uris: string[]): { date: string; title: string }[] {
  if (uris.length === 0) return [];
  const uriSet = new Set(uris);
  const all = loadAll();
  const affected: { date: string; title: string }[] = [];
  const affectedKeys: string[] = [];
  for (const [key, mix] of Object.entries(all)) {
    const hasMatch = mix.timeline.some(seg => seg.tracks.some(t => t.uri && uriSet.has(t.uri)));
    if (hasMatch) {
      affected.push({ date: mix.date, title: mix.workoutTitle });
      affectedKeys.push(key);
    }
  }
  if (affectedKeys.length > 0) {
    for (const key of affectedKeys) delete all[key];
    saveAll(all);
  }
  return affected;
}
