import { getDb } from "@/lib/db";
import { getFreshToken } from "@/lib/tokenStore";
import { getSpotifyBlockedUntil } from "@/lib/spotify-rate-limit";
import { governedCall, SpotifyBlocked, blockedRetryMs } from "@/lib/spotify-governor";
import { findPlaylistIdByName } from "@/lib/spotify-outbox";

// A private "PaceSync review" Spotify playlist kept in step with the Song Crawler's
// "awaiting review" list, so those songs can be played as a playlist: Spotify itself
// moves on to the next song when one finishes (or is accepted / deleted / removed and
// the app skips ahead), on the phone, the web player and a locked screen alike.
//
// Spotify writes are the risk here (429s), so changes are never sent one by one:
//   - a change just marks the list dirty and (re)arms a timer; everything that piled up
//     in the window goes out together
//   - the playlist is diffed against the list, then removals and additions are sent
//     100 at a time (Spotify's maximum per request) with a gap between calls
//   - nothing is sent while the "main" Spotify lane is rate-limited (the shared
//     lib/spotify-rate-limit.ts sentinel); the sync waits for it to clear, and a 429
//     here sets that same sentinel
// The app's own list is the source of truth, so a lagging playlist is harmless.

const NAME = "PaceSync review";
const DESCRIPTION = "Songs the PaceSync Song Crawler added that are waiting to be reviewed. Kept in step automatically.";
const API = "https://api.spotify.com/v1";
const DEBOUNCE_MS = 8_000;
const CALL_GAP_MS = 400;
const MAX_WAIT_MS = 10 * 60_000; // never wait longer than this for a rate limit to clear

type State = {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  dirty: boolean;
  provider: (() => string[]) | null;
  playlistId: string | null;
  synced: Set<string> | null; // URIs known to be in the playlist; null until the first successful sync
  lastError: string | null;
  bootstrapped: boolean;
};

// Survives Next.js module re-evaluation within the one server process.
const g = globalThis as unknown as { __reviewPlaylist?: State };
const st = (g.__reviewPlaylist ??= {
  timer: null, running: false, dirty: false, provider: null, playlistId: null, synced: null, lastError: null, bootstrapped: false,
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function reviewPlaylistUri(): string | null {
  return st.playlistId && st.synced ? `spotify:playlist:${st.playlistId}` : null;
}

// True once `uri` is in the Spotify playlist, so it can be the starting track of a play.
export function reviewPlaylistContains(uri: string): boolean {
  return !!st.synced?.has(uri);
}

export function reviewPlaylistStatus() {
  return { playlistId: st.playlistId, synced: st.synced?.size ?? null, pending: st.dirty || st.running, lastError: st.lastError };
}

// Marks the list changed; the sync runs once, DEBOUNCE_MS after the first change.
export function scheduleReviewSync(provider?: () => string[]): void {
  if (provider) st.provider = provider;
  st.dirty = true;
  if (st.timer || st.running) return;
  st.timer = setTimeout(() => { st.timer = null; void runSync(); }, DEBOUNCE_MS);
}

// First look after a (re)start: the playlist id and synced set are in memory only, so
// run one sync to rebuild them. Cheap to call on every poll.
export function ensureReviewSyncStarted(provider: () => string[]): void {
  if (st.bootstrapped) return;
  st.bootstrapped = true;
  scheduleReviewSync(provider);
}

// Every request goes through the governor (one at a time, spaced out, never while Spotify is rate-limiting).
async function spotifyCall(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  return governedCall(url, init, token);
}

const ID_KEY = "review_playlist_id";
function storedPlaylistId(): string | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(ID_KEY) as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as string) : null;
  } catch { return null; }
}
function storePlaylistId(id: string | null): void {
  try {
    if (id) getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(ID_KEY, JSON.stringify(id));
    else getDb().prepare("DELETE FROM kv_config WHERE key = ?").run(ID_KEY);
  } catch { /* best-effort */ }
}

async function runSync(): Promise<void> {
  if (st.running) return;
  st.running = true;
  let retryInMs: number | null = null;
  try {
    // Never sync into an active rate limit: wait for it to clear.
    const blocked = await getSpotifyBlockedUntil("main");
    if (blocked) { retryInMs = blockedRetryMs(blocked); return; }
    st.dirty = false;
    const desired = st.provider?.();
    if (!desired) return;
    const token = await getFreshToken();
    if (!token.ok) { st.lastError = `No Spotify token (${token.reason})`; return; }
    const auth = token.token;

    // Find or create the playlist (its id is remembered, so this is only searched for once).
    if (!st.playlistId) {
      let id = storedPlaylistId() ?? await findPlaylistIdByName(auth, NAME);
      if (!id) {
        const res = await spotifyCall(auth, `${API}/me/playlists`, {
          method: "POST", body: JSON.stringify({ name: NAME, description: DESCRIPTION, public: false }),
        });
        if (!res.ok) throw new Error(`Create playlist ${res.status}`);
        id = ((await res.json()) as { id: string }).id;
      }
      st.playlistId = id;
      storePlaylistId(id);
    }
    const playlistId = st.playlistId;

    // What the playlist holds now.
    const actual: string[] = [];
    let url: string | null = `${API}/playlists/${playlistId}/items?limit=100`;
    while (url) {
      const res = await spotifyCall(auth, url, {});
      if (res.status === 404) { st.playlistId = null; storePlaylistId(null); st.dirty = true; retryInMs = DEBOUNCE_MS; return; } // deleted on Spotify: start over
      if (!res.ok) throw new Error(`Read playlist ${res.status}`);
      const page = await res.json() as { next: string | null; items?: { item?: { uri?: string }; track?: { uri?: string } }[] };
      for (const it of page.items ?? []) {
        const uri = (it.item ?? it.track)?.uri;
        if (uri) actual.push(uri);
      }
      url = page.next;
    }

    const want = new Set(desired);
    const have = new Set(actual);
    const toRemove = Array.from(have).filter(u => !want.has(u));
    const toAdd = desired.filter((u, i) => !have.has(u) && desired.indexOf(u) === i);

    for (let i = 0; i < toRemove.length; i += 100) {
      const chunk = toRemove.slice(i, i + 100);
      const res = await spotifyCall(auth, `${API}/playlists/${playlistId}/items`, {
        method: "DELETE", body: JSON.stringify({ items: chunk.map(uri => ({ uri })) }),
      });
      if (!res.ok) throw new Error(`Remove ${res.status}`);
    }
    for (let i = 0; i < toAdd.length; i += 100) {
      const chunk = toAdd.slice(i, i + 100);
      const res = await spotifyCall(auth, `${API}/playlists/${playlistId}/items`, {
        method: "POST", body: JSON.stringify({ uris: chunk }),
      });
      if (!res.ok) throw new Error(`Add ${res.status}`);
    }

    st.synced = new Set([...Array.from(have).filter(u => want.has(u)), ...toAdd]);
    st.lastError = null;
    if (toRemove.length || toAdd.length) console.log(`[review-playlist] synced: +${toAdd.length} -${toRemove.length} (${st.synced.size} in playlist)`);
  } catch (e) {
    st.dirty = true;
    if (e instanceof SpotifyBlocked) {
      retryInMs = blockedRetryMs(e.until); // Spotify is rate-limiting: leave the list as it is until that clears
    } else {
      st.lastError = e instanceof Error ? e.message : String(e);
      console.warn(`[review-playlist] sync failed: ${st.lastError}`);
      retryInMs = 5 * 60_000; // back off, then try again
    }
  } finally {
    st.running = false;
    // Anything that changed during the run, or a retry, goes out in the next batch.
    if ((st.dirty || retryInMs != null) && !st.timer) {
      st.timer = setTimeout(() => { st.timer = null; void runSync(); }, retryInMs ?? DEBOUNCE_MS);
    }
  }
}
