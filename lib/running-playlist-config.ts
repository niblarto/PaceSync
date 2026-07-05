import fs from "fs";
import path from "path";

// Tracks every Spotify playlist the app has ever been pointed at as its
// "library" playlist — where BBC tracks get added, dedup runs, and deletes
// apply — plus which one is currently active. Each entry gets its own local
// CSV file (BPM/audio-feature library) so switching the active playlist
// switches which file all the BPM/pacing features read and write.

const FILE = path.join(process.cwd(), "running-playlist.json");
const CSV_DIR = path.join(process.cwd(), "public");

export interface RunningPlaylistEntry {
  name: string;
  id: string;
  csvFile: string; // filename only, relative to public/
}

interface StoreShape {
  activeId: string;
  playlists: RunningPlaylistEntry[];
}

function slugifyCsvName(name: string): string {
  const slug = name.trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${slug || "Playlist"}.csv`;
}

// Only used when no config file exists at all (fresh install predating the
// multi-playlist store). An explicitly-emptied store stays empty — deleting
// the last playlist must not resurrect a phantom "Running" entry.
function legacyDefault(): StoreShape {
  const id = process.env.NEXT_PUBLIC_RUNNING_PLAYLIST_ID ?? "";
  if (!id) return { activeId: "", playlists: [] };
  const entry: RunningPlaylistEntry = { name: "Running", id, csvFile: "Running.csv" };
  return { activeId: id, playlists: [entry] };
}

// Repairs entries saved by an earlier version of this module that hardcoded
// "Running.csv" for the first-ever playlist regardless of its actual name
// (e.g. a playlist named "Uber-Running" wrongly pointing at Running.csv).
// Renames the file on disk too, so existing library data isn't orphaned.
function healMisnamedCsv(playlists: RunningPlaylistEntry[]): RunningPlaylistEntry[] {
  return playlists.map(p => {
    if (p.csvFile !== "Running.csv" || p.name === "Running") return p;
    const correct = slugifyCsvName(p.name);
    const oldPath = path.join(CSV_DIR, p.csvFile);
    const newPath = path.join(CSV_DIR, correct);
    try {
      if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) fs.renameSync(oldPath, newPath);
    } catch { /* best-effort — fall through and just repoint the config */ }
    return { ...p, csvFile: correct };
  });
}

function loadStore(): StoreShape {
  try {
    const raw = fs.readFileSync(FILE, "utf-8");
    const data = JSON.parse(raw) as Partial<StoreShape> & { name?: string; id?: string };
    // An explicit playlists array — even an empty one — is authoritative
    if (Array.isArray(data.playlists)) {
      const playlists = healMisnamedCsv(data.playlists);
      return { activeId: data.activeId ?? playlists[0]?.id ?? "", playlists };
    }
    // Migrate legacy single-entry shape { name, id }
    if (data.id && data.name) {
      const entry: RunningPlaylistEntry = { name: data.name, id: data.id, csvFile: slugifyCsvName(data.name) };
      return { activeId: data.id, playlists: healMisnamedCsv([entry]) };
    }
  } catch { /* no config file yet — fall back to env-derived default */ }
  return legacyDefault();
}

function saveStore(store: StoreShape): void {
  fs.writeFileSync(FILE, JSON.stringify(store), "utf-8");
}

export interface RunningPlaylistConfig {
  name: string;
  id: string;
  csvFile: string;
}

// With no playlists configured this returns an empty-id sentinel: callers
// reading the CSV get a harmless missing-file path, Spotify calls fail fast.
export function loadRunningPlaylistConfig(): RunningPlaylistConfig {
  const store = loadStore();
  const active = store.playlists.find(p => p.id === store.activeId) ?? store.playlists[0];
  return active ?? { name: "", id: "", csvFile: "Running.csv" };
}

export function listRunningPlaylists(): RunningPlaylistConfig[] {
  return loadStore().playlists;
}

// Absolute path to the active playlist's local CSV library file.
export function activeCsvPath(): string {
  return path.join(CSV_DIR, loadRunningPlaylistConfig().csvFile);
}

export function csvPathFor(entry: RunningPlaylistConfig): string {
  return path.join(CSV_DIR, entry.csvFile);
}

// Add/update a playlist entry (by id) and make it the active one. Reuses an
// existing csvFile if this id is already known, otherwise derives one from
// the playlist's own name — e.g. "Uber-Running" -> Uber-Running.csv.
export function saveRunningPlaylistConfig(config: { name: string; id: string }): RunningPlaylistConfig {
  const store = loadStore();
  const existing = store.playlists.find(p => p.id === config.id);
  const csvFile = existing?.csvFile ?? slugifyCsvName(config.name);
  const entry: RunningPlaylistConfig = { name: config.name, id: config.id, csvFile };

  const others = store.playlists.filter(p => p.id !== config.id);
  const playlists = [...others, entry];
  saveStore({ activeId: config.id, playlists });
  return entry;
}

// Switch the active playlist to an already-known id (no Spotify calls).
export function setActiveRunningPlaylist(id: string): RunningPlaylistConfig | null {
  const store = loadStore();
  const entry = store.playlists.find(p => p.id === id);
  if (!entry) return null;
  saveStore({ activeId: id, playlists: store.playlists });
  return entry;
}

// Remove a playlist entry from local tracking (and delete its CSV file).
// If the removed entry was active, falls back to the first remaining one.
export function removeRunningPlaylist(id: string): void {
  const store = loadStore();
  const removed = store.playlists.find(p => p.id === id);
  const playlists = store.playlists.filter(p => p.id !== id);
  if (removed) {
    try { fs.unlinkSync(csvPathFor(removed)); } catch { /* file may not exist */ }
  }
  const activeId = store.activeId === id ? (playlists[0]?.id ?? "") : store.activeId;
  saveStore({ activeId, playlists });
}
