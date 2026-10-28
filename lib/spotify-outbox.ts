import { createHash } from "crypto";
import { getDb } from "@/lib/db";
import { getFreshToken } from "@/lib/tokenStore";
import { governedCall, SpotifyBlocked, blockedRetryMs } from "@/lib/spotify-governor";
import { getSpotifyBlockedUntil } from "@/lib/spotify-rate-limit";
import { getCachedPlaylistId, setCachedPlaylistId, clearCachedPlaylistId } from "@/lib/playlist-id-cache";
import { cronNotify } from "@/lib/cron-notify";
import { setSavedPaceProMixPlaylist } from "@/lib/pace-pro-saved";
import type { UpsertResult } from "@/lib/spotify-playlist";

// Saving a playlist to Spotify, local-first and rate-limit safe.
//
// The callers (Today's Run, the AI DJ pre-build, saved Pace Pro mixes) save the mix LOCALLY first
// and then ask for the Spotify playlist here. If Spotify is rate-limiting (or the request draws a 429)
// the save is queued - as a desired state, so a newer save of the same playlist replaces the older
// one - and is sent once the limit has cleared, through the governor (lib/spotify-governor.ts) which
// spaces requests out and cools off after a block.
//
// Requests are kept to the minimum for the change:
//   - nothing is sent if the playlist already holds exactly these tracks and description
//   - the playlist's id is remembered (no search for it each time)
//   - the description is only updated if it changed
//   - the tracks go as one request per 100 (Spotify's maximum): the first 100 replace the contents,
//     the rest are appended

const API = "https://api.spotify.com/v1";
const QUEUE_KEY = "spotify_playlist_save_queue";
const STATE_KEY = "spotify_playlist_state";
const USER_KEY = "spotify_user_id";
const MAX_ATTEMPTS = 6;

export interface SaveRequest {
  name: string;
  description: string;
  uris: string[];
  // Something to do once the playlist exists: record its id against a saved Pace Pro mix.
  after?: { kind: "paceProMix"; id: string };
}
interface PendingSave extends SaveRequest { queuedAt: string; attempts: number }
interface PlaylistState { id: string; description: string; hash: string }

export type SaveOutcome =
  | { status: "saved"; result: UpsertResult; unchanged: boolean }
  | { status: "queued"; until: string | null };

function readKv<T>(key: string, fallback: T): T {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(key) as { value_json: string } | undefined;
    if (row) return JSON.parse(row.value_json) as T;
  } catch { /* fall through */ }
  return fallback;
}
function writeKv(key: string, value: unknown): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(key, JSON.stringify(value));
}

const loadQueue = () => readKv<Record<string, PendingSave>>(QUEUE_KEY, {});
const loadState = () => readKv<Record<string, PlaylistState>>(STATE_KEY, {});
const hashOf = (uris: string[]) => createHash("sha1").update(uris.join(",")).digest("hex");

export function pendingPlaylistSaves(): { name: string; tracks: number; queuedAt: string; attempts: number }[] {
  return Object.values(loadQueue()).map(p => ({ name: p.name, tracks: p.uris.length, queuedAt: p.queuedAt, attempts: p.attempts }));
}

// ── one Spotify call, governed; non-429 failures are thrown as errors ──
export async function call(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return governedCall(`${API}${path}`, init, token);
}

export async function ownUserId(token: string): Promise<string> {
  const cached = readKv<string | null>(USER_KEY, null);
  if (cached) return cached;
  const res = await call(token, "/me");
  if (!res.ok) throw new Error(`Spotify /me ${res.status}`);
  const id = ((await res.json()) as { id: string }).id;
  writeKv(USER_KEY, id);
  return id;
}

// Finds one of your own playlists by name (governed requests; remembers your user id).
export async function findPlaylistIdByName(token: string, name: string): Promise<string | null> {
  const userId = await ownUserId(token);
  let path: string | null = "/me/playlists?limit=50";
  while (path) {
    const res = await call(token, path);
    if (!res.ok) throw new Error(`List playlists ${res.status}`);
    const data = await res.json() as { items: { id: string; name: string; owner: { id: string } }[]; next: string | null };
    const hit = data.items.find(p => p.name.toLowerCase() === name.toLowerCase() && p.owner.id === userId);
    if (hit) return hit.id;
    path = data.next ? data.next.replace(API, "") : null;
  }
  return null;
}

// Find-or-create the playlist and make it hold exactly these tracks, in as few requests as possible.
async function upsertGoverned(token: string, req: SaveRequest): Promise<UpsertResult> {
  const state = loadState()[req.name];
  let id: string | null = state?.id ?? getCachedPlaylistId(req.name) ?? null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let created = false;
    if (!id) id = await findPlaylistIdByName(token, req.name);
    if (!id) {
      const res = await call(token, "/me/playlists", { method: "POST", body: JSON.stringify({ name: req.name, description: req.description, public: true }) });
      if (!res.ok) throw new Error(`Create playlist ${res.status}: ${(await res.text()).slice(0, 200)}`);
      id = ((await res.json()) as { id: string }).id;
      created = true;
    } else if (state?.id === id && state.description !== req.description) {
      const res = await call(token, `/playlists/${id}`, { method: "PUT", body: JSON.stringify({ description: req.description }) });
      if (res.status === 404) { id = null; clearCachedPlaylistId(req.name); continue; }
      // a description that fails to update is cosmetic: carry on
    }

    const first = req.uris.slice(0, 100);
    const put = await call(token, `/playlists/${id}/items`, { method: "PUT", body: JSON.stringify({ uris: first }) });
    if (put.status === 404) { id = null; clearCachedPlaylistId(req.name); continue; } // the playlist was deleted: find / create again
    if (!put.ok) throw new Error(`Replace tracks ${put.status}: ${(await put.text()).slice(0, 200)}`);
    for (let i = 100; i < req.uris.length; i += 100) {
      const post = await call(token, `/playlists/${id}/items`, { method: "POST", body: JSON.stringify({ uris: req.uris.slice(i, i + 100) }) });
      if (!post.ok) throw new Error(`Add tracks ${post.status}: ${(await post.text()).slice(0, 200)}`);
    }

    setCachedPlaylistId(req.name, id);
    const states = loadState();
    states[req.name] = { id, description: req.description, hash: hashOf(req.uris) };
    writeKv(STATE_KEY, states);
    return { playlistId: id, url: `https://open.spotify.com/playlist/${id}`, tracksAdded: true, replaced: !created };
  }
  throw new Error("Couldn't save the playlist to Spotify");
}

// Forgets everything remembered about a playlist (queued save, cached id, state) - used after it is deleted on Spotify.
export function forgetPlaylistSave(name: string): { id: string | null } {
  const q = loadQueue();
  if (q[name]) { delete q[name]; writeKv(QUEUE_KEY, q); }
  const states = loadState();
  const id = states[name]?.id ?? getCachedPlaylistId(name) ?? null;
  if (states[name]) { delete states[name]; writeKv(STATE_KEY, states); }
  clearCachedPlaylistId(name);
  return { id };
}

function enqueue(req: SaveRequest): void {
  const q = loadQueue();
  const prev = q[req.name];
  q[req.name] = { ...req, queuedAt: prev?.queuedAt ?? new Date().toISOString(), attempts: prev?.attempts ?? 0 }; // the newest save wins
  writeKv(QUEUE_KEY, q);
}

function afterSaved(req: SaveRequest, result: UpsertResult): void {
  if (req.after?.kind === "paceProMix") {
    try { setSavedPaceProMixPlaylist(req.after.id, result.playlistId); } catch (e) { console.warn("[spotify-outbox] couldn't record the playlist id:", e); }
  }
}

// The entry point for a Spotify playlist save. Tries now unless Spotify is rate-limiting, otherwise queues it.
export async function requestPlaylistSave(token: string, req: SaveRequest): Promise<SaveOutcome> {
  ensureOutboxStarted();
  const state = loadState()[req.name];
  if (state && state.hash === hashOf(req.uris) && state.description === req.description && !loadQueue()[req.name]) {
    const result: UpsertResult = { playlistId: state.id, url: `https://open.spotify.com/playlist/${state.id}`, tracksAdded: true, replaced: true };
    afterSaved(req, result);
    return { status: "saved", result, unchanged: true };
  }
  const blocked = await getSpotifyBlockedUntil("main");
  if (blocked) {
    enqueue(req);
    schedule(blockedRetryMs(blocked));
    return { status: "queued", until: blocked };
  }
  try {
    const result = await upsertGoverned(token, req);
    const q = loadQueue();
    if (q[req.name]) { delete q[req.name]; writeKv(QUEUE_KEY, q); }
    afterSaved(req, result);
    return { status: "saved", result, unchanged: false };
  } catch (e) {
    if (e instanceof SpotifyBlocked) {
      enqueue(req);
      schedule(blockedRetryMs(e.until));
      return { status: "queued", until: e.until };
    }
    throw e;
  }
}

// ── the queue's worker ──
type Worker = { timer: ReturnType<typeof setTimeout> | null; running: boolean; started: boolean };
const g = globalThis as unknown as { __spotifyOutbox?: Worker };
const w = (g.__spotifyOutbox ??= { timer: null, running: false, started: false });

function schedule(inMs: number): void {
  if (w.timer) return;
  w.timer = setTimeout(() => { w.timer = null; void flushPlaylistSaves(); }, inMs);
}

// After a (re)start, carry on with anything still queued. Cheap to call often.
export function ensureOutboxStarted(): void {
  if (w.started) return;
  w.started = true;
  if (Object.keys(loadQueue()).length > 0) schedule(10_000);
}

export async function flushPlaylistSaves(): Promise<void> {
  if (w.running) return;
  w.running = true;
  let retryInMs: number | null = null;
  try {
    for (const name of Object.keys(loadQueue())) {
      const req = loadQueue()[name];
      if (!req) continue;
      const blocked = await getSpotifyBlockedUntil("main");
      if (blocked) { retryInMs = blockedRetryMs(blocked); return; }
      const token = await getFreshToken();
      if (!token.ok) { retryInMs = 5 * 60_000; return; }
      try {
        const result = await upsertGoverned(token.token, req);
        const q = loadQueue();
        // a newer save of this playlist may have been queued while this one was sending: keep it
        if (q[name] && hashOf(q[name].uris) === hashOf(req.uris) && q[name].description === req.description) delete q[name];
        else if (q[name]) q[name].attempts = 0;
        writeKv(QUEUE_KEY, q);
        afterSaved(req, result);
        console.log(`[spotify-outbox] saved queued playlist "${name}" (${req.uris.length} tracks)`);
        await cronNotify(`"${name}" (${req.uris.length} tracks) has been saved to Spotify. It was waiting for Spotify's rate limit to clear.`, {
          title: "✅ Playlist saved to Spotify", tags: "musical_note,white_check_mark", type: "playlist-saved", priority: "low",
        }).catch(() => {});
      } catch (e) {
        if (e instanceof SpotifyBlocked) { retryInMs = blockedRetryMs(e.until); return; }
        const q = loadQueue();
        if (q[name]) {
          q[name].attempts += 1;
          if (q[name].attempts >= MAX_ATTEMPTS) {
            delete q[name];
            console.warn(`[spotify-outbox] giving up on "${name}" after ${MAX_ATTEMPTS} attempts: ${e instanceof Error ? e.message : String(e)}`);
            await cronNotify(`Couldn't save "${name}" to Spotify after several tries (${e instanceof Error ? e.message : String(e)}). The mix is saved in PaceSync; save it to Spotify again by hand.`, {
              title: "❌ Playlist not saved to Spotify", tags: "x", type: "playlist-save-failed", priority: "high",
            }).catch(() => {});
          } else {
            retryInMs = 10 * 60_000;
          }
          writeKv(QUEUE_KEY, q);
        }
      }
    }
  } finally {
    w.running = false;
    if (retryInMs != null && Object.keys(loadQueue()).length > 0) schedule(retryInMs);
  }
}
