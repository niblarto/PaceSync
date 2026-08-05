import { getDb } from "@/lib/db";
import type { TrackRow } from "@/types/track";
import type { TrackWithBPM } from "@/types";
import { csvEscape } from "@/lib/csv-merge";
import { writeFile } from "fs/promises";
import { getBpmOverride } from "@/lib/bpm-track-overrides";

// DB-backed replacement for lib/csv-store.ts/lib/csv-merge.ts's role,
// operating on the `tracks` table instead of a CSV file. Not yet wired
// into any consumer (sub-step A of the CSV migration — schema + this
// module + the one-off import script only); every existing CSV-touching
// route keeps working unmodified until a later cutover batch.

const ROW_COLUMNS = `
  csv_file, uri, row_no, track_name, album_name, artist_names, release_date,
  duration_ms, popularity, explicit, added_by, added_at, genres, record_label,
  danceability, energy, key, loudness, mode, speechiness, acousticness,
  instrumentalness, liveness, valence, tempo, time_signature, isrc
`;

interface DbRow {
  csv_file: string; uri: string; row_no: number;
  track_name: string | null; album_name: string | null; artist_names: string | null;
  release_date: string | null; duration_ms: number | null; popularity: number | null;
  explicit: string | null; added_by: string | null; added_at: string | null;
  genres: string | null; record_label: string | null; danceability: number | null;
  energy: number | null; key: number | null; loudness: number | null; mode: number | null;
  speechiness: number | null; acousticness: number | null; instrumentalness: number | null;
  liveness: number | null; valence: number | null; tempo: number | null;
  time_signature: number | null; isrc: string | null;
}

function rowToTrackRow(r: DbRow): TrackRow {
  return {
    csvFile: r.csv_file, uri: r.uri, rowNo: r.row_no,
    trackName: r.track_name, albumName: r.album_name, artistNames: r.artist_names,
    releaseDate: r.release_date, durationMs: r.duration_ms, popularity: r.popularity,
    explicit: r.explicit, addedBy: r.added_by, addedAt: r.added_at,
    genres: r.genres, recordLabel: r.record_label, danceability: r.danceability,
    energy: r.energy, key: r.key, loudness: r.loudness, mode: r.mode,
    speechiness: r.speechiness, acousticness: r.acousticness, instrumentalness: r.instrumentalness,
    liveness: r.liveness, valence: r.valence, tempo: r.tempo, timeSignature: r.time_signature,
    isrc: r.isrc,
  };
}

// ── Read ─────────────────────────────────────────────────────────────────

export function readAllTracks(csvFile: string): TrackRow[] {
  const rows = getDb().prepare(`SELECT ${ROW_COLUMNS} FROM tracks WHERE csv_file = ? ORDER BY row_no`).all(csvFile) as DbRow[];
  return rows.map(rowToTrackRow);
}

export function countTracks(csvFile: string): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM tracks WHERE csv_file = ?").get(csvFile) as { n: number };
  return row.n;
}

// Every column key on TrackRow, mapped to its DB column name — used by
// listMissingColumn so callers can pass a typed field name rather than a
// raw SQL column string.
const COLUMN_MAP: Record<keyof TrackRow, string> = {
  csvFile: "csv_file", uri: "uri", rowNo: "row_no", trackName: "track_name",
  albumName: "album_name", artistNames: "artist_names", releaseDate: "release_date",
  durationMs: "duration_ms", popularity: "popularity", explicit: "explicit",
  addedBy: "added_by", addedAt: "added_at", genres: "genres", recordLabel: "record_label",
  danceability: "danceability", energy: "energy", key: "key", loudness: "loudness",
  mode: "mode", speechiness: "speechiness", acousticness: "acousticness",
  instrumentalness: "instrumentalness", liveness: "liveness", valence: "valence",
  tempo: "tempo", timeSignature: "time_signature", isrc: "isrc",
};

export function listMissingColumn(csvFile: string, column: keyof TrackRow, opts?: { requireUri?: boolean }): TrackRow[] {
  const col = COLUMN_MAP[column];
  const uriClause = opts?.requireUri === false ? "" : "AND uri != ''";
  const rows = getDb().prepare(
    `SELECT ${ROW_COLUMNS} FROM tracks WHERE csv_file = ? AND (${col} IS NULL OR ${col} = '') ${uriClause} ORDER BY row_no`
  ).all(csvFile) as DbRow[];
  return rows.map(rowToTrackRow);
}

export function readTracksByUris(csvFile: string, uris: string[]): TrackRow[] {
  if (uris.length === 0) return [];
  const db = getDb();
  const stmt = db.prepare(`SELECT ${ROW_COLUMNS} FROM tracks WHERE csv_file = ? AND uri = ?`);
  const out: TrackRow[] = [];
  for (const uri of uris) {
    const row = stmt.get(csvFile, uri) as DbRow | undefined;
    if (row) out.push(rowToTrackRow(row));
  }
  return out;
}

// ── Write ────────────────────────────────────────────────────────────────

const WRITABLE_COLUMNS: (keyof TrackRow)[] = [
  "trackName", "albumName", "artistNames", "releaseDate", "durationMs", "popularity",
  "explicit", "addedBy", "addedAt", "genres", "recordLabel", "danceability", "energy",
  "key", "loudness", "mode", "speechiness", "acousticness", "instrumentalness",
  "liveness", "valence", "tempo", "timeSignature", "isrc",
];

function isBlankValue(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

// Backfills only currently-NULL/blank fields on an existing (csv_file, uri)
// row — mirrors the CSV-heal sweep's isBlank-gated writes exactly (never
// overwrites a non-blank cell). No-op if no row with that uri exists yet.
export function backfillTrackFields(csvFile: string, uri: string, fields: Partial<TrackRow>): void {
  const db = getDb();
  const existing = db.prepare(`SELECT ${ROW_COLUMNS} FROM tracks WHERE csv_file = ? AND uri = ?`).get(csvFile, uri) as DbRow | undefined;
  if (!existing) return;
  const current = rowToTrackRow(existing);
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of WRITABLE_COLUMNS) {
    if (!(key in fields)) continue;
    if (!isBlankValue(current[key])) continue; // never overwrite a non-blank cell
    sets.push(`${COLUMN_MAP[key]} = ?`);
    values.push(fields[key] ?? null);
  }
  if (sets.length === 0) return;
  values.push(csvFile, uri, current.rowNo);
  db.prepare(`UPDATE tracks SET ${sets.join(", ")} WHERE csv_file = ? AND uri = ? AND row_no = ?`).run(...values);
}

// Full-row update by URI (overwrites, not blank-only) — for consumers that
// have deliberately fresh authoritative values (e.g. a ReccoBeats-driven
// features update), unlike backfillTrackFields's fill-gaps-only semantics.
export function updateTrackFeatures(csvFile: string, uri: string, fields: Partial<TrackRow>): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of WRITABLE_COLUMNS) {
    if (!(key in fields)) continue;
    sets.push(`${COLUMN_MAP[key]} = ?`);
    values.push(fields[key] ?? null);
  }
  if (sets.length === 0) return;
  values.push(csvFile, uri);
  getDb().prepare(`UPDATE tracks SET ${sets.join(", ")} WHERE csv_file = ? AND uri = ?`).run(...values);
}

function nextRowNo(csvFile: string): number {
  const row = getDb().prepare("SELECT COALESCE(MAX(row_no), 0) AS m FROM tracks WHERE csv_file = ?").get(csvFile) as { m: number };
  return row.m + 1;
}

function insertRow(csvFile: string, rowNo: number, fields: Partial<TrackRow>): void {
  const cols = ["csv_file", "uri", "row_no"];
  const placeholders = ["?", "?", "?"];
  const values: unknown[] = [csvFile, fields.uri ?? "", rowNo];
  for (const key of WRITABLE_COLUMNS) {
    if (!(key in fields)) continue;
    cols.push(COLUMN_MAP[key]);
    placeholders.push("?");
    values.push(fields[key] ?? null);
  }
  getDb().prepare(`INSERT INTO tracks (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`).run(...values);
}

export interface MergeResult { appended: number; merged: number; skipped: number; }

// Replaces lib/csv-merge.ts's mergeCsvIntoFile semantics: a new URI is
// inserted as a new row; an existing URI's row gets blank cells backfilled
// (never overwritten); a row with no URI at all is always appended
// unconditionally (matches the original's "no dedup possible" fallback).
export function mergeTracksIntoPlaylist(csvFile: string, incoming: Partial<TrackRow>[], opts?: { excludeUris?: Set<string> }): MergeResult {
  const db = getDb();
  let appended = 0, merged = 0, skipped = 0;
  const tx = db.transaction(() => {
    let rowNo = nextRowNo(csvFile);
    const seenInBatch = new Set<string>();
    for (const row of incoming) {
      const uri = row.uri?.trim();
      if (!uri) {
        insertRow(csvFile, rowNo++, row);
        appended++;
        continue;
      }
      if (opts?.excludeUris?.has(uri) || seenInBatch.has(uri)) { skipped++; continue; }
      seenInBatch.add(uri);
      const existing = db.prepare("SELECT 1 FROM tracks WHERE csv_file = ? AND uri = ?").get(csvFile, uri);
      if (existing) {
        backfillTrackFields(csvFile, uri, row);
        merged++;
      } else {
        insertRow(csvFile, rowNo++, row);
        appended++;
      }
    }
  });
  tx();
  return { appended, merged, skipped };
}

export function appendTracks(csvFile: string, rows: Partial<TrackRow>[]): number {
  const db = getDb();
  let count = 0;
  const tx = db.transaction(() => {
    let rowNo = nextRowNo(csvFile);
    for (const row of rows) {
      insertRow(csvFile, rowNo++, row);
      count++;
    }
  });
  tx();
  return count;
}

// Atomically replaces a playlist's entire track set — deletes every
// existing row and inserts the new ones in a single transaction, so a
// crash mid-operation can never leave the playlist empty (which two
// separate deleteAllTracksForPlaylist + appendTracks calls could).
export function replaceAllTracks(csvFile: string, rows: Partial<TrackRow>[]): number {
  const db = getDb();
  let count = 0;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM tracks WHERE csv_file = ?").run(csvFile);
    let rowNo = 1;
    for (const row of rows) {
      insertRow(csvFile, rowNo++, row);
      count++;
    }
  });
  tx();
  return count;
}

// ── Delete ───────────────────────────────────────────────────────────────

export function deleteTracksByUri(csvFile: string, uris: string[]): number {
  if (uris.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare("DELETE FROM tracks WHERE csv_file = ? AND uri = ?");
  let n = 0;
  const tx = db.transaction(() => {
    for (const uri of uris) n += stmt.run(csvFile, uri).changes;
  });
  tx();
  return n;
}

export function deleteTracksWithNoUri(csvFile: string): number {
  return getDb().prepare("DELETE FROM tracks WHERE csv_file = ? AND uri = ''").run(csvFile).changes;
}

export function deleteAllTracksForPlaylist(csvFile: string): number {
  return getDb().prepare("DELETE FROM tracks WHERE csv_file = ?").run(csvFile).changes;
}

// ── Registry (running_playlists) ────────────────────────────────────────

export interface RunningPlaylistEntry { name: string; id: string; csvFile: string; }

export function listRunningPlaylists(): RunningPlaylistEntry[] {
  const rows = getDb().prepare("SELECT id, name, csv_file FROM running_playlists").all() as { id: string; name: string; csv_file: string }[];
  return rows.map(r => ({ id: r.id, name: r.name, csvFile: r.csv_file }));
}

export function loadRunningPlaylistConfigRow(): RunningPlaylistEntry | null {
  const row = getDb().prepare("SELECT id, name, csv_file FROM running_playlists WHERE is_active = 1").get() as
    { id: string; name: string; csv_file: string } | undefined;
  return row ? { id: row.id, name: row.name, csvFile: row.csv_file } : null;
}

export function setActiveRunningPlaylistRow(id: string): RunningPlaylistEntry | null {
  const db = getDb();
  const existing = db.prepare("SELECT id, name, csv_file FROM running_playlists WHERE id = ?").get(id) as
    { id: string; name: string; csv_file: string } | undefined;
  if (!existing) return null;
  const tx = db.transaction(() => {
    db.prepare("UPDATE running_playlists SET is_active = 0").run();
    db.prepare("UPDATE running_playlists SET is_active = 1 WHERE id = ?").run(id);
  });
  tx();
  return { id: existing.id, name: existing.name, csvFile: existing.csv_file };
}

export function removeRunningPlaylistRow(id: string): void {
  const db = getDb();
  const entry = db.prepare("SELECT csv_file FROM running_playlists WHERE id = ?").get(id) as { csv_file: string } | undefined;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM running_playlists WHERE id = ?").run(id);
    if (entry) deleteAllTracksForPlaylist(entry.csv_file);
  });
  tx();
}

// ── CSV-text projection (for the not-yet-migrated Python boundary) ───────

const CSV_HEADERS = [
  "Track URI", "Track Name", "Album Name", "Artist Name(s)", "Release Date",
  "Duration (ms)", "Popularity", "Explicit", "Added By", "Added At", "Genres",
  "Record Label", "Danceability", "Energy", "Key", "Loudness", "Mode",
  "Speechiness", "Acousticness", "Instrumentalness", "Liveness", "Valence",
  "Tempo", "Time Signature",
];

function trackRowToCsvRow(t: TrackRow): string[] {
  // Bake in any persistent BPM correction (lib/bpm-track-overrides.ts) so
  // EVERY consumer of this CSV text/file — including the Python-facing
  // materialized file, which previously never saw overrides via the local
  // AI DJ fallback subprocess — gets the corrected Tempo value, not just
  // the remote-service path that used to patch it separately in-memory.
  const override = t.uri ? getBpmOverride(t.uri) : null;
  const tempo = override ? override.value : t.tempo;
  return [
    t.uri, t.trackName ?? "", t.albumName ?? "", t.artistNames ?? "", t.releaseDate ?? "",
    t.durationMs?.toString() ?? "", t.popularity?.toString() ?? "", t.explicit ?? "",
    t.addedBy ?? "", t.addedAt ?? "", t.genres ?? "", t.recordLabel ?? "",
    t.danceability?.toString() ?? "", t.energy?.toString() ?? "", t.key?.toString() ?? "",
    t.loudness?.toString() ?? "", t.mode?.toString() ?? "", t.speechiness?.toString() ?? "",
    t.acousticness?.toString() ?? "", t.instrumentalness?.toString() ?? "", t.liveness?.toString() ?? "",
    t.valence?.toString() ?? "", tempo?.toString() ?? "", t.timeSignature?.toString() ?? "",
  ];
}

export function tracksToCsvText(rows: TrackRow[]): string {
  const lines = [CSV_HEADERS, ...rows.map(trackRowToCsvRow)];
  return lines.map(r => r.map(csvEscape).join(",")).join("\n") + "\n";
}

export function csvTextForPlaylist(csvFile: string): string {
  return tracksToCsvText(readAllTracks(csvFile));
}

// Regenerates the on-disk CSV file for a playlist from the DB — the
// safety-net dual-write that keeps the Python-facing file (bpm/suggest,
// bpm/similar, the local AI DJ fallback subprocess — none of which are
// migrated off CSV yet) byte-consistent with the DB after every write.
// Takes the destination path as a parameter (rather than importing
// csvPathFor from running-playlist-config.ts) to avoid a circular import,
// since that module's registry functions are themselves backed by this one.
export async function regenerateCsvFile(csvFile: string, destPath: string): Promise<void> {
  await writeFile(destPath, csvTextForPlaylist(csvFile), "utf8");
}

// ── Projection to the UI/mixer's TrackWithBPM shape ─────────────────────

export function toTrackWithBPM(row: TrackRow): TrackWithBPM | null {
  if (!row.uri) return null;
  const id = row.uri.startsWith("spotify:track:") ? row.uri.slice("spotify:track:".length) : row.uri;
  return {
    id,
    name: row.trackName ?? "Unknown",
    artists: [{ name: row.artistNames ?? "Unknown" }],
    album: { name: row.albumName ?? "", images: [] },
    duration_ms: row.durationMs ?? 0,
    uri: row.uri,
    bpm: row.tempo != null ? Math.round(row.tempo) : 0,
    energy: row.energy ?? 0,
  };
}
