import { getDb } from "@/lib/db";
import { matchKey } from "@/lib/csv-store";

// Permanent log of tracks the user has deleted from the library. Import
// paths (BBC card, CSV append, similar-song adds, weekly cron) check this
// so a deleted track never silently reappears: manual imports surface the
// matches for per-track override, the cron rejects them automatically.
// Overriding an entry (re-importing the track) removes it from the log.

export interface DeletedTrack {
  name: string;
  artist: string;
  deletedAt: string; // ISO date
}

export type DeletedTrackLog = Record<string, DeletedTrack>; // key: spotify:track:<id>

export function loadDeletedTracks(): DeletedTrackLog {
  const rows = getDb().prepare("SELECT uri, name, artist, deleted_at FROM deleted_tracks").all() as
    { uri: string; name: string | null; artist: string | null; deleted_at: string }[];
  const log: DeletedTrackLog = {};
  for (const r of rows) log[r.uri] = { name: r.name ?? "", artist: r.artist ?? "", deletedAt: r.deleted_at };
  return log;
}

export function recordDeletedTracks(tracks: { uri: string; name?: string; artist?: string }[]): void {
  if (tracks.length === 0) return;
  const now = new Date().toISOString();
  const stmt = getDb().prepare(
    "INSERT INTO deleted_tracks (uri, name, artist, deleted_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(uri) DO UPDATE SET name = excluded.name, artist = excluded.artist, deleted_at = excluded.deleted_at"
  );
  for (const t of tracks) {
    if (!t.uri) continue;
    stmt.run(t.uri, t.name ?? "", t.artist ?? "", now);
  }
}

// Which of these URIs were previously deleted? Returns the matching log
// entries keyed by URI (empty object = nothing to reject).
export function findPreviouslyDeleted(uris: string[]): Record<string, DeletedTrack> {
  if (uris.length === 0) return {};
  const db = getDb();
  const hits: Record<string, DeletedTrack> = {};
  const stmt = db.prepare("SELECT name, artist, deleted_at FROM deleted_tracks WHERE uri = ?");
  for (const uri of uris) {
    if (!uri) continue;
    const row = stmt.get(uri) as { name: string | null; artist: string | null; deleted_at: string } | undefined;
    if (row) hits[uri] = { name: row.name ?? "", artist: row.artist ?? "", deletedAt: row.deleted_at };
  }
  return hits;
}

// Same check, but for a row that has no Spotify URI yet (e.g. a pasted
// title/artist/BPM import, before any online lookup has run) — matches by
// the same loose name+artist key lib/csv-store.ts's workbook-import flows
// already use, so "Song (Radio Edit)" still matches a deleted "Song"
// logged under a slightly different title. Every deleted-tracks row is
// loaded and keyed once (the table is small — a user's own deletion
// history, not the whole library) rather than one query per candidate.
export function findPreviouslyDeletedByName(candidates: { name: string; artist: string }[]): Map<number, DeletedTrack> {
  if (candidates.length === 0) return new Map();
  const rows = getDb().prepare("SELECT name, artist, deleted_at FROM deleted_tracks").all() as
    { name: string | null; artist: string | null; deleted_at: string }[];
  const byKey = new Map<string, DeletedTrack>();
  for (const r of rows) {
    if (!r.name || !r.artist) continue;
    byKey.set(matchKey(r.name, r.artist), { name: r.name, artist: r.artist, deletedAt: r.deleted_at });
  }
  const hits = new Map<number, DeletedTrack>();
  candidates.forEach((c, i) => {
    const hit = byKey.get(matchKey(c.name, c.artist));
    if (hit) hits.set(i, hit);
  });
  return hits;
}

// A user explicitly chose to re-import these — forget the deletions so
// future imports don't flag them again.
export function removeFromDeletedLog(uris: string[]): void {
  if (uris.length === 0) return;
  const db = getDb();
  const stmt = db.prepare("DELETE FROM deleted_tracks WHERE uri = ?");
  for (const uri of uris) stmt.run(uri);
}
