import { readAllTracks } from "@/lib/tracks-store";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { getFreshToken } from "@/lib/tokenStore";
import { addTracksToLibrary } from "@/lib/library-add";
import { findPreviouslyDeleted } from "@/lib/deleted-tracks";
import { healActiveCsv } from "@/lib/csv-heal";
import { governedCall, SpotifyBlocked } from "@/lib/spotify-governor";
import { flushSpotifyRemovals, pendingSpotifyRemovals, queueSpotifyRemovals } from "@/lib/spotify-removals";

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
const MAX_REMOVALS_PER_RUN = 1000;
// More Spotify-only tracks than this is far more likely tracks removed from the library whose
// Spotify removal never went through (e.g. during a rate limit) than that many added on Spotify
// by hand, so they are NOT imported back - reported for a look instead.
const MAX_IMPORTS_PER_RUN = 25;

export interface LibrarySyncResult {
  ok: boolean;
  error?: string;
  libraryCount: number;
  spotifyCount: number;
  addedToSpotify: number;
  importedToLibrary: number;
  removedFromSpotify: number;
  skippedRemovals?: number;
  skippedImports?: number;
  queuedRemovals?: number;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// One Spotify call, through the governor: one at a time, spaced out, never while Spotify is
// rate-limiting. A 429 stops the sync (SpotifyBlocked) instead of being waited out and retried.
async function spotifyCall(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  return governedCall(url, init, token);
}

export async function syncLibraryWithSpotify(): Promise<LibrarySyncResult> {
  try {
    return await syncLibraryWithSpotifyInner();
  } catch (e) {
    if (e instanceof SpotifyBlocked) {
      return { libraryCount: 0, spotifyCount: 0, addedToSpotify: 0, importedToLibrary: 0, removedFromSpotify: 0, ok: false, error: `Spotify is rate-limiting until ${e.until ?? "later"} - the sync was skipped and will run again tomorrow` };
    }
    throw e;
  }
}

async function syncLibraryWithSpotifyInner(): Promise<LibrarySyncResult> {
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

  // Removals already queued (a delete whose Spotify request was rejected or is still waiting): not
  // imported back and not counted again - the queue sends them.
  const alreadyQueued = pendingSpotifyRemovals(config.id);

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
  const spotifyOnly = Array.from(spotify.keys()).filter(u => !libraryUris.has(u) && !alreadyQueued.has(u));
  const deleted = findPreviouslyDeleted(spotifyOnly);
  const toRemove = spotifyOnly.filter(u => deleted[u]);
  const toImport = spotifyOnly.filter(u => !deleted[u]);

  if (toRemove.length > MAX_REMOVALS_PER_RUN) {
    // Safety valve — an unexpectedly large removal is more likely a data
    // problem than intent; leave Spotify alone and report it.
    result.skippedRemovals = toRemove.length;
  } else {
    // Queued, then sent through the shared removal queue (batched, retried after a rate limit).
    queueSpotifyRemovals(toRemove, config.id);
    result.queuedRemovals = toRemove.length;
  }
  const flushed = await flushSpotifyRemovals().catch(() => null);
  result.removedFromSpotify += flushed?.removed ?? 0;

  if (toImport.length > MAX_IMPORTS_PER_RUN) {
    result.skippedImports = toImport.length;
  } else if (toImport.length > 0) {
    const { added } = await addTracksToLibrary(toImport.map(uri => ({ uri, ...spotify.get(uri)! })));
    result.importedToLibrary = added;
    // Backfill BPM/duration/features/genres for the imported rows.
    if (added > 0) void healActiveCsv().catch(e => console.warn("[library-sync] heal failed:", e));
  }

  return result;
}
