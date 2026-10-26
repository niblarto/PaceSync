import { activeCsvPath, loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { readTracksByUris, deleteTracksByUri, regenerateCsvFile } from "@/lib/tracks-store";
import { recordDeletedTracks } from "@/lib/deleted-tracks";
import { queueSpotifyRemovals } from "@/lib/spotify-removals";

// Server-side library delete for callers with no browser Spotify token (the
// Android app's Song Crawler tab): removes the track from the library CSV
// and records it in the deletion log — same steps as /api/tracks/delete —
// then removes it from the Spotify playlist with the stored login. Mixes
// containing it are left as they are (flagged by lib/broken-tracklists.ts).
// skipDeletedLog: "Remove" — out of the library and playlist, but not put
// on the deleted list, so a later crawl/import can add it again.
export async function deleteFromLibraryServer(uri: string, skipDeletedLog = false): Promise<{ removed: boolean; spotify: boolean }> {
  const fullUri = uri.startsWith("spotify:track:") ? uri : `spotify:track:${uri}`;
  const config = loadRunningPlaylistConfig();
  const matched = readTracksByUris(config.csvFile, [fullUri]);
  let removed = false;
  if (matched.length > 0) {
    deleteTracksByUri(config.csvFile, matched.map(t => t.uri));
    await regenerateCsvFile(config.csvFile, activeCsvPath());
    if (!skipDeletedLog) try {
      recordDeletedTracks(matched.map(t => ({ uri: t.uri, name: t.trackName ?? undefined, artist: t.artistNames ?? undefined })));
    } catch (e) { console.warn("[library-delete] deletion log failed:", e); }
    removed = true;
  }
  // Queued (batched, retried after a rate limit) instead of one request per track.
  let spotify = false;
  if (config.id) { queueSpotifyRemovals([fullUri], config.id); spotify = true; }
  return { removed, spotify };
}
