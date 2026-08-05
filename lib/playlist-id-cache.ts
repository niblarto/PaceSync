import { getDb } from "@/lib/db";

// Caches a resolved "playlist name -> Spotify playlist id" mapping so
// repeated callers (the two daily AI DJ cron jobs, both targeting the same
// standing "Today's Run" playlist) don't re-scan the user's entire playlist
// library via GET /me/playlists every single run — Spotify's rate limit is
// per-app and shared across every endpoint in a rolling 30s window, so an
// unconditional, guaranteed-twice-daily full-library scan for an ID that
// almost never changes is pure waste. Cached indefinitely (no TTL): a
// stale/wrong id is self-healing at the call site (lib/spotify-playlist.ts's
// upsertPlaylist re-scans and re-caches if the cached id 404s), so there's
// no correctness risk in caching this "forever."

const KEY_PREFIX = "playlist_id_cache:";

export function getCachedPlaylistId(name: string): string | null {
  const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY_PREFIX + name.toLowerCase()) as { value_json: string } | undefined;
  if (!row) return null;
  try {
    const data = JSON.parse(row.value_json) as { id?: string };
    return data.id ?? null;
  } catch {
    return null;
  }
}

export function setCachedPlaylistId(name: string, id: string): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY_PREFIX + name.toLowerCase(), JSON.stringify({ id }));
}

export function clearCachedPlaylistId(name: string): void {
  getDb().prepare("DELETE FROM kv_config WHERE key = ?").run(KEY_PREFIX + name.toLowerCase());
}
