import fs from "fs";
import path from "path";

// Timestamps every track written to the active library CSV, so recently-
// added tracks can be surfaced (e.g. the BBC page's "Added this week" list)
// without needing an "Added At" column in the CSV itself. Keyed per active
// playlist's CSV file, since different playlists have entirely different
// libraries and add histories. Pruned to the retention window on every
// write — this log only needs to answer "what's new," not serve as a
// permanent history.

const RETAIN_DAYS = 14;

function logPath(csvFile: string): string {
  return path.join(process.cwd(), `added-tracks-${csvFile.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
}

export interface AddedTrack {
  addedAt: string; // ISO date
}

type AddedTrackLog = Record<string, AddedTrack>; // key: spotify:track:<id>

function loadAll(csvFile: string): AddedTrackLog {
  try {
    return JSON.parse(fs.readFileSync(logPath(csvFile), "utf-8")) as AddedTrackLog;
  } catch {
    return {};
  }
}

function saveAll(csvFile: string, log: AddedTrackLog): void {
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
  for (const uri of Object.keys(log)) {
    if (new Date(log[uri].addedAt).getTime() < cutoff) delete log[uri];
  }
  fs.writeFileSync(logPath(csvFile), JSON.stringify(log), "utf-8");
}

export function recordAddedTracks(csvFile: string, uris: string[]): void {
  if (uris.length === 0) return;
  const log = loadAll(csvFile);
  const now = new Date().toISOString();
  for (const uri of uris) {
    if (!uri) continue;
    log[uri] = { addedAt: now };
  }
  saveAll(csvFile, log);
}

// Every logged URI added within the last `days` days, newest first.
export function getRecentlyAdded(csvFile: string, days = 7): { uri: string; addedAt: string }[] {
  const log = loadAll(csvFile);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return Object.entries(log)
    .filter(([, v]) => new Date(v.addedAt).getTime() >= cutoff)
    .map(([uri, v]) => ({ uri, addedAt: v.addedAt }))
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}
