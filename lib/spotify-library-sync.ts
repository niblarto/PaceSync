import { readAllTracks } from "@/lib/tracks-store";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { getFreshToken } from "@/lib/tokenStore";
import { addTracksToLibrary } from "@/lib/library-add";
import { findPreviouslyDeleted } from "@/lib/deleted-tracks";
import { healActiveCsv } from "@/lib/csv-heal";

// Daily two-way sync between the local library and its Spotify playlist
// (the "librarySync" cron job). Works purely off URIs already on both
// sides — never Spotify's Search API, the past 429-ban trigger — so a run
// is ~20 paginated reads plus one write per 100 changed tracks.
//
//   library-only           -> added to the Spotify playlist
//   Spotify-only, deleted  -> removed from Spotify (the deletion log says
//                             the user removed it from the library)
//   Spotify-only, other    -> imported into the library (added on Spotify)

const API = "https://api.spotify.com/v1";
const TRACK_URI_RE = /^spotify:track:[A-Za-z0-9]{22}$/;
const CALL_GAP_MS = 400;
const MAX_REMOVALS_PER_RUN = 100;

export interface LibrarySyncResult {
  ok: boolean;
  error?: string;
  libraryCount: number;
  spotifyCount: number;
  addedToSpotify: number;
  importedToLibrary: number;
  removedFromSpotify: number;
  skippedRemovals?: number;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// One Spotify call with 429 handling: waits Retry-After (capped) and retries.
async function spotifyCall(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    await sleep(CALL_GAP_MS);
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    if (res.status !== 429 || attempt >= 3) return res;
    const wait = Math.min(Number(res.headers.get("Retry-After") ?? "5") || 5, 120);
    console.log(`[library-sync] 429 — waiting ${wait}s (attempt ${attempt + 1})`);
    await sleep(wait * 1000);
  }
}

export async function syncLibraryWithSpotify(): Promise<LibrarySyncResult> {
  const base = { libraryCount: 0, spotifyCount: 0, addedToSpotify: 0, importedToLibrary: 0, removedFromSpotify: 0 };
  const config = loadRunningPlaylistConfig();
  if (!config.id) return { ...base, ok: false, error: "No Spotify playlist configured for the library" };

  const library = readAllTracks(config.csvFile);
  const libraryUris = new Set(library.map(t => t.uri).filter(u => TRACK_URI_RE.test(u)));
  // An empty/unreadable library would otherwise look like "everything is
  // Spotify-only" and mass-import or mass-remove — never act on that.
  if (libraryUris.size === 0) return { ...base, ok: false, error: "Library is empty — refusing to sync" };

  const token = await getFreshToken();
  if (!token.ok) return { ...base, ok: false, error: `No Spotify token (${token.reason})` };

  // Read the whole playlist first; any failed page aborts before writing.
  const spotify = new Map<string, { name: string; artist: string }>();
  let url: string | null = `${API}/playlists/${config.id}/items?limit=100`;
  while (url) {
    const res = await spotifyCall(token.token, url);
    if (!res.ok) return { ...base, libraryCount: libraryUris.size, ok: false, error: `Reading playlist failed (${res.status})` };
    const page = await res.json() as {
      next: string | null;
      items?: { item?: { uri?: string; name?: string; artists?: { name: string }[] }; track?: { uri?: string; name?: string; artists?: { name: string }[] } }[];
    };
    for (const it of page.items ?? []) {
      const t = it.item ?? it.track;
      if (t?.uri && TRACK_URI_RE.test(t.uri)) {
        spotify.set(t.uri, { name: t.name ?? "", artist: (t.artists ?? []).map(a => a.name).join(", ") });
      }
    }
    url = page.next;
  }

  const result: LibrarySyncResult = { ...base, ok: true, libraryCount: libraryUris.size, spotifyCount: spotify.size };

  // 1. Library-only -> Spotify.
  const toAdd = Array.from(libraryUris).filter(u => !spotify.has(u));
  for (let i = 0; i < toAdd.length; i += 100) {
    const chunk = toAdd.slice(i, i + 100);
    const res = await spotifyCall(token.token, `${API}/playlists/${config.id}/items`, {
      method: "POST", body: JSON.stringify({ uris: chunk }),
    });
    if (!res.ok) return { ...result, ok: false, error: `Adding to Spotify failed (${res.status}): ${(await res.text()).slice(0, 200)}` };
    result.addedToSpotify += chunk.length;
  }

  // 2. Spotify-only: deleted from the library -> remove; otherwise import.
  const spotifyOnly = Array.from(spotify.keys()).filter(u => !libraryUris.has(u));
  const deleted = findPreviouslyDeleted(spotifyOnly);
  const toRemove = spotifyOnly.filter(u => deleted[u]);
  const toImport = spotifyOnly.filter(u => !deleted[u]);

  if (toRemove.length > MAX_REMOVALS_PER_RUN) {
    // Safety valve — an unexpectedly large removal is more likely a data
    // problem than intent; leave Spotify alone and report it.
    result.skippedRemovals = toRemove.length;
  } else {
    for (let i = 0; i < toRemove.length; i += 100) {
      const chunk = toRemove.slice(i, i + 100);
      const res = await spotifyCall(token.token, `${API}/playlists/${config.id}/items`, {
        method: "DELETE", body: JSON.stringify({ items: chunk.map(uri => ({ uri })) }),
      });
      if (!res.ok) return { ...result, ok: false, error: `Removing from Spotify failed (${res.status})` };
      result.removedFromSpotify += chunk.length;
    }
  }

  if (toImport.length > 0) {
    const { added } = await addTracksToLibrary(toImport.map(uri => ({ uri, ...spotify.get(uri)! })));
    result.importedToLibrary = added;
    // Backfill BPM/duration/features/genres for the imported rows.
    if (added > 0) void healActiveCsv().catch(e => console.warn("[library-sync] heal failed:", e));
  }

  return result;
}
