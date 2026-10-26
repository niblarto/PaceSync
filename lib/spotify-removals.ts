import { getDb } from "@/lib/db";
import { getFreshToken } from "@/lib/tokenStore";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { getSpotifyBlockedUntil, setSpotifyBlockedUntil, parseRetryAfter, recordSpotifyRequest } from "@/lib/spotify-rate-limit";

// Removing deleted tracks from the Spotify playlist, with a persistent retry queue.
//
// Deleting a track used to fire a Spotify "remove from playlist" request from the browser and
// forget it. When Spotify was rate-limiting (429) the request was rejected and nothing retried
// it: the track was gone from the library but stayed on the Spotify playlist, and the nightly
// library sync could then treat it as a new Spotify-side addition and import it back.
//
// Now the delete routes only QUEUE the removal here. The queue is kept on disk (so it survives
// a restart), and is flushed to Spotify in batches of 100 (Spotify's maximum), with a gap
// between requests, never while the shared "main" rate-limit sentinel is active, and again
// after a 429 clears. A removal leaves the queue only once Spotify accepts it.

const KEY = "pending_spotify_removals";
const API = "https://api.spotify.com/v1";
const DEBOUNCE_MS = 5_000;
const CALL_GAP_MS = 400;
const RETRY_MS = 5 * 60_000;
const MAX_WAIT_MS = 10 * 60_000; // re-check at least this often while rate-limited

type Pending = Record<string, string[]>; // playlist id -> track URIs waiting to be removed

function load(): Pending {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    if (row) return JSON.parse(row.value_json) as Pending;
  } catch { /* fall through */ }
  return {};
}

function save(p: Pending): void {
  for (const k of Object.keys(p)) if (p[k].length === 0) delete p[k];
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(p));
}

type State = { timer: ReturnType<typeof setTimeout> | null; running: boolean; started: boolean };
const g = globalThis as unknown as { __spotifyRemovals?: State };
const st = (g.__spotifyRemovals ??= { timer: null, running: false, started: false });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function schedule(inMs: number): void {
  if (st.timer) return;
  st.timer = setTimeout(() => { st.timer = null; void flushSpotifyRemovals(); }, inMs);
}

// Queue tracks for removal from the playlist (default: the active library playlist).
export function queueSpotifyRemovals(uris: string[], playlistId: string | null = loadRunningPlaylistConfig().id || null): void {
  if (!playlistId || uris.length === 0) return;
  const p = load();
  const set = new Set(p[playlistId] ?? []);
  for (const u of uris) set.add(u.startsWith("spotify:track:") ? u : `spotify:track:${u}`);
  p[playlistId] = Array.from(set);
  save(p);
  schedule(DEBOUNCE_MS);
}

// The tracks still waiting to be removed from a playlist (so the library sync can leave them alone).
export function pendingSpotifyRemovals(playlistId: string): Set<string> {
  return new Set(load()[playlistId] ?? []);
}

export function pendingSpotifyRemovalCount(): number {
  return Object.values(load()).reduce((n, l) => n + l.length, 0);
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
    if (blockedUntil) {
      retryInMs = Math.min(Math.max(new Date(blockedUntil).getTime() - Date.now(), 5_000) + 2_000, MAX_WAIT_MS);
      return { removed: 0, pending: pendingSpotifyRemovalCount(), blockedUntil };
    }
    const token = await getFreshToken();
    if (!token.ok) { retryInMs = RETRY_MS; return { removed: 0, pending: pendingSpotifyRemovalCount(), blockedUntil: null }; }

    for (const playlistId of Object.keys(load())) {
      for (;;) {
        const chunk = (load()[playlistId] ?? []).slice(0, 100);
        if (chunk.length === 0) break;
        await sleep(CALL_GAP_MS);
        recordSpotifyRequest();
        const res = await fetch(`${API}/playlists/${playlistId}/items`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ items: chunk.map(uri => ({ uri })) }),
        }).catch(() => null);
        if (res?.status === 429) {
          const wait = Math.min(parseRetryAfter(res.headers.get("Retry-After") ?? "30"), 3600);
          blockedUntil = new Date(Date.now() + wait * 1000).toISOString();
          await setSpotifyBlockedUntil(blockedUntil, "main");
          retryInMs = Math.min(wait * 1000 + 2_000, MAX_WAIT_MS);
          console.warn(`[spotify-removals] 429 - ${pendingSpotifyRemovalCount()} removals stay queued; Spotify blocked until ${blockedUntil}`);
          return { removed, pending: pendingSpotifyRemovalCount(), blockedUntil };
        }
        // 404: the playlist no longer exists, so there is nothing to remove from. Anything
        // else that isn't a success keeps the batch queued for another try.
        if (res?.ok || res?.status === 404) {
          const p = load();
          const done = new Set(chunk);
          p[playlistId] = (p[playlistId] ?? []).filter(u => !done.has(u));
          save(p);
          if (res.ok) removed += chunk.length;
        } else {
          console.warn(`[spotify-removals] batch failed (${res ? res.status : "no response"}) - will retry`);
          retryInMs = RETRY_MS;
          return { removed, pending: pendingSpotifyRemovalCount(), blockedUntil: null };
        }
      }
    }
    if (removed > 0) console.log(`[spotify-removals] removed ${removed} track(s) from the Spotify playlist`);
    return { removed, pending: pendingSpotifyRemovalCount(), blockedUntil: null };
  } catch (e) {
    console.warn(`[spotify-removals] flush failed: ${e instanceof Error ? e.message : String(e)}`);
    retryInMs = RETRY_MS;
    return { removed, pending: pendingSpotifyRemovalCount(), blockedUntil };
  } finally {
    st.running = false;
    if (retryInMs != null && pendingSpotifyRemovalCount() > 0) schedule(retryInMs);
  }
}
