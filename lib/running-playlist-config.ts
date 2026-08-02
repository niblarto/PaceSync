import path from "path";
import fs from "fs";
import { getDb } from "@/lib/db";
import {
  listRunningPlaylists as listRunningPlaylistsRows,
  loadRunningPlaylistConfigRow,
  setActiveRunningPlaylistRow,
  removeRunningPlaylistRow,
  regenerateCsvFile,
} from "@/lib/tracks-store";

// Tracks every Spotify playlist the app has ever been pointed at as its
// "library" playlist — where BBC tracks get added, dedup runs, and deletes
// apply — plus which one is currently active. Each entry's actual track
// data lives in the `tracks` table (lib/tracks-store.ts), scoped by
// csvFile; this module is now just the registry (running_playlists table)
// plus the CSV-file-path helpers still needed by not-yet-migrated Python
// consumers (bpm/suggest, bpm/similar, the local AI DJ fallback) — every
// write path that touches tracks also regenerates this on-disk file so it
// stays byte-consistent with the DB.

const CSV_DIR = path.join(process.cwd(), "public");

export interface RunningPlaylistEntry {
  name: string;
  id: string;
  csvFile: string; // filename only, relative to public/
}

function slugifyCsvName(name: string): string {
  const slug = name.trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${slug || "Playlist"}.csv`;
}

export interface RunningPlaylistConfig {
  name: string;
  id: string;
  csvFile: string;
}

// With no playlists configured this returns an empty-id sentinel: callers
// reading the CSV get a harmless missing-file path, Spotify calls fail fast.
export function loadRunningPlaylistConfig(): RunningPlaylistConfig {
  return loadRunningPlaylistConfigRow() ?? { name: "", id: "", csvFile: "Running.csv" };
}

export function listRunningPlaylists(): RunningPlaylistConfig[] {
  return listRunningPlaylistsRows();
}

// Absolute path to the active playlist's local CSV library file — still a
// real, regenerated-on-write file (see lib/tracks-store.ts's
// regenerateCsvFile) since bpm/suggest, bpm/similar, and the local AI DJ
// fallback subprocess are Python and not yet migrated off reading a CSV.
export function activeCsvPath(): string {
  return path.join(CSV_DIR, loadRunningPlaylistConfig().csvFile);
}

export function csvPathFor(entry: RunningPlaylistConfig): string {
  return path.join(CSV_DIR, entry.csvFile);
}

// Pseudo-path consumed by bpm_matcher.features.load_playlist /
// scripts/ai_dj_bridge.py's _load_library (both local, on-Pi Python
// processes) to read the active playlist's tracks straight out of
// pacesync.db instead of the materialized CSV file — sub-step C of the
// SQLite migration. Not used by the remote AI DJ HTTP service
// (ai_dj/server.py), which has no filesystem access to this DB and keeps
// receiving CSV text over the wire via csvTextForPlaylist() instead.
export function dbSourcePath(): string {
  const dbPath = path.join(process.cwd(), "pacesync.db");
  return `db://${dbPath}::${loadRunningPlaylistConfig().csvFile}`;
}

// Add/update a playlist entry (by id) and, by default, make it the active
// one. Reuses an existing csvFile if this id is already known, otherwise
// derives one from the playlist's own name — e.g. "Uber-Running" ->
// Uber-Running.csv. Pass keepCurrentActive when registering a playlist that
// isn't meant to take over as active (e.g. a brand-new copy-to target
// created from another tab/feature).
export function saveRunningPlaylistConfig(
  config: { name: string; id: string },
  opts: { keepCurrentActive?: boolean } = {},
): RunningPlaylistConfig {
  const db = getDb();
  const existing = db.prepare("SELECT csv_file FROM running_playlists WHERE id = ?").get(config.id) as { csv_file: string } | undefined;
  const csvFile = existing?.csv_file ?? slugifyCsvName(config.name);
  const entry: RunningPlaylistConfig = { name: config.name, id: config.id, csvFile };

  const tx = db.transaction(() => {
    if (!opts.keepCurrentActive) db.prepare("UPDATE running_playlists SET is_active = 0").run();
    db.prepare(
      "INSERT INTO running_playlists (id, name, csv_file, is_active) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET name = excluded.name, csv_file = excluded.csv_file" +
      (opts.keepCurrentActive ? "" : ", is_active = 1")
    ).run(config.id, config.name, csvFile, opts.keepCurrentActive ? 0 : 1);
  });
  tx();

  // Ensure the (possibly brand-new) playlist has a CSV file on disk, even
  // with zero tracks yet — some consumers check file existence.
  const dest = csvPathFor(entry);
  if (!fs.existsSync(dest)) regenerateCsvFile(csvFile, dest).catch(() => {});

  return entry;
}

// Switch the active playlist to an already-known id (no Spotify calls).
export function setActiveRunningPlaylist(id: string): RunningPlaylistConfig | null {
  return setActiveRunningPlaylistRow(id);
}

// Remove a playlist entry from local tracking (and delete its CSV file).
// If the removed entry was active, falls back to the first remaining one.
export function removeRunningPlaylist(id: string): void {
  const db = getDb();
  const removed = db.prepare("SELECT csv_file FROM running_playlists WHERE id = ?").get(id) as { csv_file: string } | undefined;
  removeRunningPlaylistRow(id);
  if (removed) {
    try { fs.unlinkSync(path.join(CSV_DIR, removed.csv_file)); } catch { /* file may not exist */ }
  }
  // If the removed entry was active, promote the first remaining one.
  const activeNow = db.prepare("SELECT 1 FROM running_playlists WHERE is_active = 1").get();
  if (!activeNow) {
    const first = db.prepare("SELECT id FROM running_playlists LIMIT 1").get() as { id: string } | undefined;
    if (first) setActiveRunningPlaylistRow(first.id);
  }
}
