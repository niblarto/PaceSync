import { getDb } from "@/lib/db";

// Every AI DJ mix build (remix or first build, saved or not) for a workout
// date, so a remix — or a reload mid-remix-chain, or the overnight cron —
// still demotes tracks from recent attempts instead of starting fresh each
// time. Distinct from todays-run-history.ts's "confirmed played" log (which
// only gets a row once a mix is actually saved/pinned): this fires on every
// build attempt, whether saved or not, since the point is variety across
// remixes, not tracking what actually got listened to.
//
// Deliberately keyed by date ALONE (no workout_title column) — unlike every
// other workout-scoped store in this app, this one never adopted the
// (date, workout_title) composite key, even in its JSON-era form.

const RETAIN_DAYS = 3; // only recent remix history matters for freshness
const MAX_BUILDS_PER_DATE = 8; // cap so a long remix session can't grow this unbounded

// Records one build's track URIs against its workout date. Called after
// every successful mix build (see app/api/ai-dj/mix/route.ts).
export function recordMixBuild(date: string, uris: string[]): void {
  if (!date || uris.length === 0) return;
  try {
    const db = getDb();
    const tx = db.transaction(() => {
      db.prepare("INSERT INTO recent_mix_builds (date, built_at, uris_json) VALUES (?, ?, ?)")
        .run(date, new Date().toISOString(), JSON.stringify(uris));

      // Cap to the most recent MAX_BUILDS_PER_DATE rows for this date —
      // delete anything older than the Nth-most-recent by rowid.
      const excess = db.prepare(
        "SELECT rowid FROM recent_mix_builds WHERE date = ? ORDER BY rowid DESC LIMIT -1 OFFSET ?"
      ).all(date, MAX_BUILDS_PER_DATE) as { rowid: number }[];
      if (excess.length > 0) {
        const del = db.prepare("DELETE FROM recent_mix_builds WHERE rowid = ?");
        for (const row of excess) del.run(row.rowid);
      }

      const cutoffIso = new Date(Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      db.prepare("DELETE FROM recent_mix_builds WHERE date < ?").run(cutoffIso);
    });
    tx();
  } catch (e) {
    console.warn("[recent-mix-builds] save failed:", e);
  }
}

// Every URI built for this date across all recent attempts — merged with
// the client's own accumulated avoidUris so a page reload doesn't lose the
// exclusion chain, and the overnight cron (which has no client state at
// all) still avoids repeating its own most recent attempt for the same date.
export function getRecentBuildUris(date: string): string[] {
  if (!date) return [];
  const rows = getDb().prepare("SELECT uris_json FROM recent_mix_builds WHERE date = ?").all(date) as { uris_json: string }[];
  const all = new Set<string>();
  for (const row of rows) (JSON.parse(row.uris_json) as string[]).forEach(u => all.add(u));
  return Array.from(all);
}
