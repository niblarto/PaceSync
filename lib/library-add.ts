import { activeCsvPath, loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { readCsv, writeCsv, rowFrom } from "@/lib/csv-store";
import { findPreviouslyDeleted, removeFromDeletedLog, type DeletedTrack } from "@/lib/deleted-tracks";
import { recordAddedTracks } from "@/lib/added-tracks";

// Single shared "add tracks to the library CSV" path — used by the
// /api/tracks/add route (BBC card, similar-song suggestions) and the weekly
// BBC cron, so previously-deleted-track rejection lives in exactly one place.

export interface LibraryAddTrack {
  uri: string;
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
// user — written anyway and removed from the deletion log.
export async function addTracksToLibrary(tracks: LibraryAddTrack[], allowDeletedUris?: string[]): Promise<LibraryAddResult> {
  const allowed = new Set(allowDeletedUris ?? []);
  const previouslyDeleted: Record<string, DeletedTrack> = findPreviouslyDeleted(tracks.map(t => t.uri));
  const rejected = Object.entries(previouslyDeleted)
    .filter(([uri]) => !allowed.has(uri))
    .map(([uri, d]) => ({ uri, name: d.name, artist: d.artist, deletedAt: d.deletedAt }));
  const rejectedUris = new Set(rejected.map(r => r.uri));

  const overridden = tracks.filter(t => previouslyDeleted[t.uri] && allowed.has(t.uri)).map(t => t.uri);
  if (overridden.length > 0) {
    try { removeFromDeletedLog(overridden); } catch (e) { console.warn("[library-add] deletion log update failed:", e); }
  }

  const csvPath = activeCsvPath();
  const { headers, rows, col } = await readCsv(csvPath);
  const idxUri = col("Track URI", "Spotify URI", "uri", "id");
  const existingUris = new Set(idxUri !== -1 ? rows.map(r => r[idxUri]?.trim()).filter(Boolean) : []);

  const fresh = tracks.filter(t => t.uri && !rejectedUris.has(t.uri) && !existingUris.has(t.uri));

  const newRows = fresh.map(t => rowFrom(headers, {
    "Track URI": t.uri,
    "Track Name": t.name,
    "Artist Name(s)": t.artist,
    "Tempo": t.tempo,
    "Key": t.key,
    "Mode": t.mode,
    "Energy": t.energy,
    "Danceability": t.danceability,
    "Valence": t.valence,
  }));

  if (newRows.length > 0) {
    await writeCsv(csvPath, headers, [...rows, ...newRows]);
    try {
      recordAddedTracks(loadRunningPlaylistConfig().csvFile, fresh.map(t => t.uri));
    } catch (e) { console.warn("[library-add] added-tracks log failed:", e); }
  }

  return { added: newRows.length, rejected };
}
