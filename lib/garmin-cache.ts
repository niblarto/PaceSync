import fs from "fs";
import path from "path";

// In-process singleton cache keyed on garmin_activities.db mtime.
// When the daily GarminDB cron runs, the DB mtime changes and the
// entire cache is invalidated on the next incoming request.

let cachedMtime = 0;
const store = new Map<string, unknown>();

function dbMtime(dbDir: string): number {
  try {
    return fs.statSync(path.join(dbDir, "garmin_activities.db")).mtimeMs;
  } catch {
    return 0;
  }
}

export function garminCacheGet<T>(key: string, dbDir: string): T | null {
  const mtime = dbMtime(dbDir);
  if (mtime !== cachedMtime) {
    store.clear();
    cachedMtime = mtime;
    return null;
  }
  return store.has(key) ? (store.get(key) as T) : null;
}

export function garminCacheSet<T>(key: string, dbDir: string, data: T): void {
  cachedMtime = dbMtime(dbDir);
  store.set(key, data);
}
