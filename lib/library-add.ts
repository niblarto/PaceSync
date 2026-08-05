import { activeCsvPath, loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { readAllTracks, mergeTracksIntoPlaylist, regenerateCsvFile } from "@/lib/tracks-store";
import { findPreviouslyDeleted, removeFromDeletedLog, type DeletedTrack } from "@/lib/deleted-tracks";
import { recordAddedTracks } from "@/lib/added-tracks";

// Single shared "add tracks to the library CSV" path — used by the
// /api/tracks/add route (BBC card, similar-song suggestions) and the weekly
// BBC cron, so previously-deleted-track rejection lives in exactly one place.

export interface LibraryAddTrack {
  // Exactly one of uri/isrc is expected to be set. uri-less rows come from
  // "search more by this artist" (Deezer top-tracks resolved by ISRC, not a
  // Spotify search — see components/DashboardClient.tsx's
  // searchArtistTopTracks) and stay URI-less until the heal sweep resolves
  // the real Spotify URI via an `isrc:` search (lib/csv-heal.ts).
  uri?: string;
  isrc?: string;
  name: string;
  artist: string;
  tempo?: number;
  key?: number;
  mode?: number;
  energy?: number;
  danceability?: number;
  valence?: number;
}

export interface LibraryAddResult {
  added: number;
  // Previously-deleted tracks held back (not written). Callers surface these
  // for per-track override, or (cron) just log them.
  rejected: { uri: string; name: string; artist: string; deletedAt: string }[];
}

// allowDeletedUris: previously-deleted tracks explicitly overridden by the
// user — written anyway and removed from the deletion log. Only applies to
// uri-bearing tracks; a pending (uri-less) ISRC track can't have been
// through the delete flow yet, so it's never checked against this log.
export async function addTracksToLibrary(tracks: LibraryAddTrack[], allowDeletedUris?: string[]): Promise<LibraryAddResult> {
  const allowed = new Set(allowDeletedUris ?? []);
  const uriTracks = tracks.filter(t => t.uri);
  const previouslyDeleted: Record<string, DeletedTrack> = findPreviouslyDeleted(uriTracks.map(t => t.uri!));
  const rejected = Object.entries(previouslyDeleted)
    .filter(([uri]) => !allowed.has(uri))
    .map(([uri, d]) => ({ uri, name: d.name, artist: d.artist, deletedAt: d.deletedAt }));
  const rejectedUris = new Set(rejected.map(r => r.uri));

  const overridden = uriTracks.filter(t => previouslyDeleted[t.uri!] && allowed.has(t.uri!)).map(t => t.uri!);
  if (overridden.length > 0) {
    try { removeFromDeletedLog(overridden); } catch (e) { console.warn("[library-add] deletion log update failed:", e); }
  }

  const config = loadRunningPlaylistConfig();
  const csvFile = config.csvFile;
  const existingRows = readAllTracks(csvFile);
  const existingUris = new Set(existingRows.map(t => t.uri).filter(Boolean));
  const existingIsrcs = new Set(existingRows.map(t => t.isrc).filter((v): v is string => !!v));

  const freshUriTracks = uriTracks.filter(t => !rejectedUris.has(t.uri!) && !existingUris.has(t.uri!));
  // Pending (uri-less, isrc-only) tracks: dedup by ISRC instead, since
  // there's no Spotify URI yet to key off — same track picked twice from
  // "search more by this artist" (e.g. across two sessions) shouldn't add
  // a second pending row.
  const freshIsrcTracks = tracks.filter(t => !t.uri && t.isrc && !existingIsrcs.has(t.isrc));
  const fresh = [...freshUriTracks, ...freshIsrcTracks];

  const newRows = fresh.map(t => ({
    uri: t.uri ?? "",
    isrc: t.isrc ?? null,
    trackName: t.name,
    artistNames: t.artist,
    tempo: t.tempo,
    key: t.key,
    mode: t.mode,
    energy: t.energy,
    danceability: t.danceability,
    valence: t.valence,
  }));

  if (newRows.length > 0) {
    mergeTracksIntoPlaylist(csvFile, newRows);
    await regenerateCsvFile(csvFile, activeCsvPath());
    if (freshUriTracks.length > 0) {
      try {
        recordAddedTracks(csvFile, freshUriTracks.map(t => t.uri!));
      } catch (e) { console.warn("[library-add] added-tracks log failed:", e); }
    }
  }

  return { added: newRows.length, rejected };
}
