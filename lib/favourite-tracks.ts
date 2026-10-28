import { getDb } from "@/lib/db";

// Tracks starred as favourites. Pace Pro and Race mixes put these first for any segment whose BPM they fit
// (see ai_dj/workout.py's favourite handling); no other mix uses them. Kept apart from the library CSV so a
// library rebuild or heal can never lose a star.
const KEY = "favourite_tracks";

export function getFavouriteUris(): string[] {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    const list = row ? JSON.parse(row.value_json) as unknown : [];
    return Array.isArray(list) ? list.filter((u): u is string => typeof u === "string") : [];
  } catch {
    return [];
  }
}

export function setFavourite(uri: string, favourite: boolean): string[] {
  const set = new Set(getFavouriteUris());
  if (favourite) set.add(uri); else set.delete(uri);
  const list = Array.from(set);
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(list));
  return list;
}
