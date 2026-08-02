import { getDb } from "@/lib/db";

// Durable, append-only record of confirmed plays per track — separate from
// todays-run-history (a live snapshot store subject to deletion/unpin
// cascades and 90-day pruning). Once a workout is confirmed ("Yes, I ran to
// this"), each track's count here is permanent: nothing else in the app
// (track deletion, mix rebuilds, pin/unpin, history pruning) touches this
// table, so a count reflects "confirmed runs to date" and can only grow.
//
// play_counts_credited guards against double-crediting the same workout
// twice (e.g. an accidental double-click, or undo-then-reconfirm) — a given
// date+title only ever awards its tracks once, ever. Uses real
// (date, workout_title) PRIMARY KEY columns rather than the string
// workoutKey(date,title) format the JSON-era store used.

// Credits each distinct track URI in `uris` with +1, once, for this
// date+title. Safe to call more than once for the same workout — a repeat
// call (e.g. re-confirming after an undo) is a no-op.
export function creditConfirmedPlay(date: string, title: string, uris: (string | null)[]): void {
  try {
    const db = getDb();
    const already = db.prepare("SELECT 1 FROM play_counts_credited WHERE date = ? AND workout_title = ?").get(date, title);
    if (already) return;
    const seen = new Set<string>();
    const upsert = db.prepare(
      "INSERT INTO play_counts (uri, count) VALUES (?, 1) ON CONFLICT(uri) DO UPDATE SET count = count + 1"
    );
    const tx = db.transaction(() => {
      for (const uri of uris) {
        if (!uri || seen.has(uri)) continue;
        seen.add(uri);
        upsert.run(uri);
      }
      db.prepare("INSERT INTO play_counts_credited (date, workout_title) VALUES (?, ?)").run(date, title);
    });
    tx();
  } catch (e) {
    console.warn("[play-counts] credit failed:", e);
  }
}

export function getPlayCounts(): Record<string, number> {
  const rows = getDb().prepare("SELECT uri, count FROM play_counts").all() as { uri: string; count: number }[];
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.uri] = r.count;
  return counts;
}
