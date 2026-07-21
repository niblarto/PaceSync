import fs from "fs";
import path from "path";

// Permanent log of tracks the user has deleted from the library. Import
// paths (BBC card, CSV append, similar-song adds, weekly cron) check this
// so a deleted track never silently reappears: manual imports surface the
// matches for per-track override, the cron rejects them automatically.
// Overriding an entry (re-importing the track) removes it from the log.

const FILE = path.join(process.cwd(), "deleted-tracks.json");

export interface DeletedTrack {
  name: string;
  artist: string;
  deletedAt: string; // ISO date
}

export type DeletedTrackLog = Record<string, DeletedTrack>; // key: spotify:track:<id>

export function loadDeletedTracks(): DeletedTrackLog {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8")) as DeletedTrackLog;
  } catch {
    return {};
  }
}

function save(log: DeletedTrackLog): void {
  fs.writeFileSync(FILE, JSON.stringify(log, null, 2), "utf-8");
}

export function recordDeletedTracks(tracks: { uri: string; name?: string; artist?: string }[]): void {
  if (tracks.length === 0) return;
  const log = loadDeletedTracks();
  const now = new Date().toISOString();
  for (const t of tracks) {
    if (!t.uri) continue;
    log[t.uri] = { name: t.name ?? "", artist: t.artist ?? "", deletedAt: now };
  }
  save(log);
}

// Which of these URIs were previously deleted? Returns the matching log
// entries keyed by URI (empty object = nothing to reject).
export function findPreviouslyDeleted(uris: string[]): Record<string, DeletedTrack> {
  const log = loadDeletedTracks();
  const hits: Record<string, DeletedTrack> = {};
  for (const uri of uris) {
    if (uri && log[uri]) hits[uri] = log[uri];
  }
  return hits;
}

// A user explicitly chose to re-import these — forget the deletions so
// future imports don't flag them again.
export function removeFromDeletedLog(uris: string[]): void {
  if (uris.length === 0) return;
  const log = loadDeletedTracks();
  let changed = false;
  for (const uri of uris) {
    if (uri in log) { delete log[uri]; changed = true; }
  }
  if (changed) save(log);
}
