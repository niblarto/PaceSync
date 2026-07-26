import fs from "fs";
import path from "path";
import type { AiDjMixResponse } from "@/lib/ai-dj-mix";

// Mixes pinned to a workout date from the dashboard. The nightly AI DJ
// pre-build uses a pinned mix for that date verbatim instead of generating a
// fresh one. Pruned once the date is more than a week past.

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
  Object.keys(all).forEach(date => {
    if (new Date(date + "T12:00:00").getTime() < cutoff) delete all[date];
  });
  fs.writeFileSync(FILE, JSON.stringify(all), "utf-8");
}

export function getPinnedMix(date: string): PinnedMix | null {
  return loadAll()[date] ?? null;
}

export function setPinnedMix(entry: PinnedMix): void {
  const all = loadAll();
  all[entry.date] = entry;
  saveAll(all);
}

export function removePinnedMix(date: string): void {
  const all = loadAll();
  delete all[date];
  saveAll(all);
}

// Unpins every pinned mix that contains any of the given track URIs — used
// when a track is deleted from the library, so a pinned mix can never keep
// pointing at a track that no longer exists, regardless of which mix (if
// any) happens to be loaded in the browser at the time. Returns the dates
// that were unpinned, so callers can also drop their history snapshot.
export function unpinMixesContaining(uris: string[]): string[] {
  if (uris.length === 0) return [];
  const uriSet = new Set(uris);
  const all = loadAll();
  const affectedDates: string[] = [];
  for (const [date, mix] of Object.entries(all)) {
    const hasMatch = mix.timeline.some(seg => seg.tracks.some(t => t.uri && uriSet.has(t.uri)));
    if (hasMatch) affectedDates.push(date);
  }
  if (affectedDates.length > 0) {
    for (const date of affectedDates) delete all[date];
    saveAll(all);
  }
  return affectedDates;
}
