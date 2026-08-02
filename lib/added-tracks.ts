import { getDb } from "@/lib/db";

// Timestamps every track written to the active library CSV, so recently-
// added tracks can be surfaced (e.g. the BBC page's "Added this week" list)
// without needing an "Added At" column in the CSV itself. Keyed per active
// playlist's CSV file, since different playlists have entirely different
// libraries and add histories. Pruned to the retention window on every
// write — this log only needs to answer "what's new," not serve as a
// permanent history.

const RETAIN_DAYS = 14;

export interface AddedTrack {
  addedAt: string; // ISO date
}

export function recordAddedTracks(csvFile: string, uris: string[]): void {
  if (uris.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  const cutoffIso = new Date(Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const tx = db.transaction(() => {
    const upsert = db.prepare(
      "INSERT INTO added_tracks (csv_file, uri, added_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(csv_file, uri) DO UPDATE SET added_at = excluded.added_at"
    );
    for (const uri of uris) {
      if (!uri) continue;
      upsert.run(csvFile, uri, now);
    }
    db.prepare("DELETE FROM added_tracks WHERE csv_file = ? AND added_at < ?").run(csvFile, cutoffIso);
  });
  tx();
}

// Every logged URI added within the last `days` days, newest first.
export function getRecentlyAdded(csvFile: string, days = 7): { uri: string; addedAt: string }[] {
  const cutoffIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = getDb().prepare(
    "SELECT uri, added_at FROM added_tracks WHERE csv_file = ? AND added_at >= ? ORDER BY added_at DESC"
  ).all(csvFile, cutoffIso) as { uri: string; added_at: string }[];
  return rows.map(r => ({ uri: r.uri, addedAt: r.added_at }));
}
