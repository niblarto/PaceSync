import { getDb } from "@/lib/db";
import { getFreshToken } from "@/lib/tokenStore";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { getSpotifyBlockedUntil } from "@/lib/spotify-rate-limit";
import { governedCall, SpotifyBlocked, blockedRetryMs } from "@/lib/spotify-governor";

// Playlist track changes (removals AND additions) with a persistent queue.
//
// Deleting a track used to fire a Spotify "remove from playlist" request from the browser and forget
// it. When Spotify was rate-limiting (429) the request was rejected and nothing retried it: the track
// was gone from the library but stayed on the Spotify playlist, and the nightly library sync could
// then treat it as a new Spotify-side addition and import it back.
//
// Now the delete routes (and the Spotify relay, for adds and removes the browser sends while Spotify
// is blocking) only QUEUE the change here. The queue is kept on disk, so it survives a restart, and
// is sent through the governor (lib/spotify-governor.ts): one request at a time, spaced out, never
// while Spotify is rate-limiting, with a cool-off afterwards. Removals go out first, then additions,
// in batches of 100 (Spotify's maximum per request), so a large change is a handful of requests. A
// change leaves the queue only once Spotify accepts it.

const REMOVE_KEY = "pending_spotify_removals";
const ADD_KEY = "pending_spotify_adds";
const API = "https://api.spotify.com/v1";
const DEBOUNCE_MS = 5_000;
const RETRY_MS = 5 * 60_000;

type Pending = Record<string, string[]>; // playlist id -> track URIs waiting

function load(key: string): Pending {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(key) as { value_json: string } | undefined;
    if (row) return JSON.parse(row.value_json) as Pending;
  } catch { /* fall through */ }
  return {};
}

function save(key: string, p: Pending): void {
  for (const k of Object.keys(p)) if (p[k].length === 0) delete p[k];
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(key, JSON.stringify(p));
}

type State = { timer: ReturnType<typeof setTimeout> | null; running: boolean; started: boolean };
const g = globalThis as unknown as { __spotifyRemovals?: State };
const st = (g.__spotifyRemovals ??= { timer: null, running: false, started: false });

function schedule(inMs: number): void {
  if (st.timer) return;
  st.timer = setTimeout(() => { st.timer = null; void flushSpotifyRemovals(); }, inMs);
}

const asTrackUri = (u: string) => (u.startsWith("spotify:track:") ? u : `spotify:track:${u}`);

function queueInto(key: string, uris: string[], playlistId: string | null): void {
  if (!playlistId || uris.length === 0) return;
  const p = load(key);
  const set = new Set(p[playlistId] ?? []);
  for (const u of uris) set.add(asTrackUri(u));
  p[playlistId] = Array.from(set);
  save(key, p);
  schedule(DEBOUNCE_MS);
}

// Queue tracks for removal from the playlist (default: the active library playlist).
export function queueSpotifyRemovals(uris: string[], playlistId: string | null = loadRunningPlaylistConfig().id || null): void {
  queueInto(REMOVE_KEY, uris, playlistId);
  // A removal cancels a queued addition of the same track.
  if (playlistId) {
    const adds = load(ADD_KEY);
    if (adds[playlistId]) {
      const drop = new Set(uris.map(asTrackUri));
      adds[playlistId] = adds[playlistId].filter(u => !drop.has(u));
      save(ADD_KEY, adds);
    }
  }
}

// Queue tracks to be added to a playlist (the relay does this for browser adds sent while blocked).
export function queueSpotifyAdds(uris: string[], playlistId: string): void {
  queueInto(ADD_KEY, uris, playlistId);
}

// The tracks still waiting to be removed from a playlist (so the library sync can leave them alone).
export function pendingSpotifyRemovals(playlistId: string): Set<string> {
  return new Set(load(REMOVE_KEY)[playlistId] ?? []);
}

// For the Status tab: what is waiting, per playlist.
export function pendingSpotifyChangeSummary(): { playlistId: string; removals: number; adds: number }[] {
  const removals = load(REMOVE_KEY);
  const adds = load(ADD_KEY);
  return Array.from(new Set([...Object.keys(removals), ...Object.keys(adds)]))
    .map(playlistId => ({ playlistId, removals: removals[playlistId]?.length ?? 0, adds: adds[playlistId]?.length ?? 0 }))
    .filter(c => c.removals + c.adds > 0);
}

export function pendingSpotifyRemovalCount(): number {
  return Object.values(load(REMOVE_KEY)).reduce((n, l) => n + l.length, 0)
    + Object.values(load(ADD_KEY)).reduce((n, l) => n + l.length, 0);
}

// First look after a (re)start: pick the queue up where it was left. Cheap to call often.
export function ensureSpotifyRemovalsStarted(): void {
  if (st.started) return;
  st.started = true;
  if (pendingSpotifyRemovalCount() > 0) schedule(DEBOUNCE_MS);
}

export async function flushSpotifyRemovals(): Promise<{ removed: number; pending: number; blockedUntil: string | null }> {
  if (st.running) return { removed: 0, pending: pendingSpotifyRemovalCount(), blockedUntil: null };
  st.running = true;
  let removed = 0;
  let blockedUntil: string | null = null;
  let retryInMs: number | null = null;
  try {
    if (pendingSpotifyRemovalCount() === 0) return { removed: 0, pending: 0, blockedUntil: null };
    blockedUntil = await getSpotifyBlockedUntil("main");
    if (blockedUntil) { retryInMs = blockedRetryMs(blockedUntil); return { removed: 0, pending: pendingSpotifyRemovalCount(), blockedUntil }; }
    const token = await getFreshToken();
    if (!token.ok) { retryInMs = RETRY_MS; return { removed: 0, pending: pendingSpotifyRemovalCount(), blockedUntil: null }; }

    for (const [key, method] of [[REMOVE_KEY, "DELETE"], [ADD_KEY, "POST"]] as const) {
      for (const playlistId of Object.keys(load(key))) {
        for (;;) {
          const chunk = (load(key)[playlistId] ?? []).slice(0, 100);
          if (chunk.length === 0) break;
          const res = await governedCall(`${API}/playlists/${playlistId}/items`, {
            method,
            body: JSON.stringify(method === "DELETE" ? { items: chunk.map(uri => ({ uri })) } : { uris: chunk }),
          }, token.token);
          // 404: the playlist no longer exists, so there is nothing to change. Anything else that isn't
          // a success keeps the batch queued for another try.
          if (res.ok || res.status === 404) {
            const p = load(key);
            const done = new Set(chunk);
            p[playlistId] = (p[playlistId] ?? []).filter(u => !done.has(u));
            save(key, p);
            if (res.ok && method === "DELETE") removed += chunk.length;
          } else {
            console.warn(`[spotify-removals] ${method} batch failed (${res.status}) - will retry`);
            retryInMs = RETRY_MS;
            return { removed, pending: pendingSpotifyRemovalCount(), blockedUntil: null };
          }
        }
      }
    }
    if (removed > 0) console.log(`[spotify-removals] removed ${removed} track(s) from the Spotify playlist`);
    return { removed, pending: pendingSpotifyRemovalCount(), blockedUntil: null };
  } catch (e) {
    if (e instanceof SpotifyBlocked) {
      blockedUntil = e.until;
      retryInMs = blockedRetryMs(e.until);
      console.warn(`[spotify-removals] Spotify is rate-limiting - ${pendingSpotifyRemovalCount()} change(s) stay queued until ${e.until}`);
    } else {
      console.warn(`[spotify-removals] flush failed: ${e instanceof Error ? e.message : String(e)}`);
      retryInMs = RETRY_MS;
    }
    return { removed, pending: pendingSpotifyRemovalCount(), blockedUntil };
  } finally {
    st.running = false;
    if (retryInMs != null && pendingSpotifyRemovalCount() > 0) schedule(retryInMs);
  }
}
