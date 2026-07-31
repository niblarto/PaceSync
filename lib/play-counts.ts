import fs from "fs";
import path from "path";
import { workoutKey } from "@/lib/workout-key";

// Durable, append-only record of confirmed plays per track — separate from
// todays-run-history.json (which is a live snapshot store subject to
// deletion/unpin cascades and 90-day pruning). Once a workout is confirmed
// ("Yes, I ran to this"), each track's count here is permanent: nothing else
// in the app (track deletion, mix rebuilds, pin/unpin, history pruning)
// touches this file, so a count reflects "confirmed runs to date" and can
// only grow.
//
// creditedWorkouts guards against double-crediting the same workout twice
// (e.g. an accidental double-click, or undo-then-reconfirm) — a given
// date+title only ever awards its tracks once, ever.

const FILE = path.join(process.cwd(), "play-counts.json");

interface PlayCountsStore {
  counts: Record<string, number>;       // uri -> confirmed play count
  creditedWorkouts: Record<string, true>; // workoutKey -> already credited
}

function load(): PlayCountsStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf-8")) as Partial<PlayCountsStore>;
    return { counts: parsed.counts ?? {}, creditedWorkouts: parsed.creditedWorkouts ?? {} };
  } catch {
    return { counts: {}, creditedWorkouts: {} };
  }
}

function save(store: PlayCountsStore): void {
  fs.writeFileSync(FILE, JSON.stringify(store), "utf-8");
}

// Credits each distinct track URI in `uris` with +1, once, for this
// date+title. Safe to call more than once for the same workout — a repeat
// call (e.g. re-confirming after an undo) is a no-op.
export function creditConfirmedPlay(date: string, title: string, uris: (string | null)[]): void {
  try {
    const store = load();
    const key = workoutKey(date, title);
    if (store.creditedWorkouts[key]) return;
    const seen = new Set<string>();
    for (const uri of uris) {
      if (!uri || seen.has(uri)) continue;
      seen.add(uri);
      store.counts[uri] = (store.counts[uri] ?? 0) + 1;
    }
    store.creditedWorkouts[key] = true;
    save(store);
  } catch (e) {
    console.warn("[play-counts] credit failed:", e);
  }
}

export function getPlayCounts(): Record<string, number> {
  return load().counts;
}
