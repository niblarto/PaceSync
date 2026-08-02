import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { activeCsvPath, loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { healActiveCsv } from "@/lib/csv-heal";
import { parseCsv } from "@/lib/csv-store";
import { mergeTracksIntoPlaylist, regenerateCsvFile, replaceAllTracks } from "@/lib/tracks-store";
import type { TrackRow } from "@/types/track";
import { findPreviouslyDeleted, removeFromDeletedLog } from "@/lib/deleted-tracks";

// Maps a parsed upload row (by column-name lookup) into the TrackRow partial
// shape tracks-store expects, so both append and overwrite modes share the
// same column-name -> field mapping.
function rowsFromUpload(parsed: ReturnType<typeof parseCsv>): Partial<TrackRow>[] {
  const { rows, col } = parsed;
  const idx = {
    uri: col("Track URI", "Spotify URI", "Spotify ID", "uri", "id"),
    trackName: col("Track Name"),
    albumName: col("Album Name"),
    artistNames: col("Artist Name(s)"),
    releaseDate: col("Release Date"),
    durationMs: col("Duration (ms)"),
    popularity: col("Popularity"),
    explicit: col("Explicit"),
    addedBy: col("Added By"),
    addedAt: col("Added At"),
    genres: col("Genres"),
    recordLabel: col("Record Label"),
    danceability: col("Danceability"),
    energy: col("Energy"),
    key: col("Key"),
    loudness: col("Loudness"),
    mode: col("Mode"),
    speechiness: col("Speechiness"),
    acousticness: col("Acousticness"),
    instrumentalness: col("Instrumentalness"),
    liveness: col("Liveness"),
    valence: col("Valence"),
    tempo: col("Tempo"),
    timeSignature: col("Time Signature"),
  };
  const numOrNull = (v: string | undefined): number | null => {
    if (v == null || v.trim() === "") return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  };
  const strOrNull = (v: string | undefined): string | null => (v == null || v.trim() === "" ? null : v.trim());
  return rows.map(row => ({
    uri: idx.uri !== -1 ? (row[idx.uri]?.trim() ?? "") : "",
    trackName: idx.trackName !== -1 ? strOrNull(row[idx.trackName]) : null,
    albumName: idx.albumName !== -1 ? strOrNull(row[idx.albumName]) : null,
    artistNames: idx.artistNames !== -1 ? strOrNull(row[idx.artistNames]) : null,
    releaseDate: idx.releaseDate !== -1 ? strOrNull(row[idx.releaseDate]) : null,
    durationMs: idx.durationMs !== -1 ? numOrNull(row[idx.durationMs]) : null,
    popularity: idx.popularity !== -1 ? numOrNull(row[idx.popularity]) : null,
    explicit: idx.explicit !== -1 ? strOrNull(row[idx.explicit]) : null,
    addedBy: idx.addedBy !== -1 ? strOrNull(row[idx.addedBy]) : null,
    addedAt: idx.addedAt !== -1 ? strOrNull(row[idx.addedAt]) : null,
    genres: idx.genres !== -1 ? strOrNull(row[idx.genres]) : null,
    recordLabel: idx.recordLabel !== -1 ? strOrNull(row[idx.recordLabel]) : null,
    danceability: idx.danceability !== -1 ? numOrNull(row[idx.danceability]) : null,
    energy: idx.energy !== -1 ? numOrNull(row[idx.energy]) : null,
    key: idx.key !== -1 ? numOrNull(row[idx.key]) : null,
    loudness: idx.loudness !== -1 ? numOrNull(row[idx.loudness]) : null,
    mode: idx.mode !== -1 ? numOrNull(row[idx.mode]) : null,
    speechiness: idx.speechiness !== -1 ? numOrNull(row[idx.speechiness]) : null,
    acousticness: idx.acousticness !== -1 ? numOrNull(row[idx.acousticness]) : null,
    instrumentalness: idx.instrumentalness !== -1 ? numOrNull(row[idx.instrumentalness]) : null,
    liveness: idx.liveness !== -1 ? numOrNull(row[idx.liveness]) : null,
    valence: idx.valence !== -1 ? numOrNull(row[idx.valence]) : null,
    tempo: idx.tempo !== -1 ? numOrNull(row[idx.tempo]) : null,
    timeSignature: idx.timeSignature !== -1 ? numOrNull(row[idx.timeSignature]) : null,
  }));
}

function extractUris(csvText: string): string[] {
  const parsed = parseCsv(csvText);
  const idxUri = parsed.col("Track URI", "Spotify URI", "Spotify ID", "uri", "id");
  if (idxUri === -1) return [];
  return parsed.rows.map(r => r[idxUri]?.trim()).filter((u): u is string => !!u);
}

// Any CSV write can introduce rows with missing data — sweep afterwards
// (in the background; upload responses shouldn't wait on API lookups).
function healInBackground(context: string) {
  void healActiveCsv().catch(e => console.warn(`[${context}] heal failed:`, e));
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const mode = req.nextUrl.searchParams.get("mode") === "append" ? "append" : "overwrite";
  const csv = await req.text();
  if (!csv) {
    return NextResponse.json({ error: "No CSV data" }, { status: 400 });
  }

  const csvFile = loadRunningPlaylistConfig().csvFile;
  const dest = activeCsvPath();

  if (mode === "append") {
    // Previously-deleted tracks are held back for review. First call (no
    // confirm flag): if any incoming URI is in the deletion log, nothing is
    // written — the rejected list comes back so the UI can show a review
    // with per-track override checkboxes. Confirmed call (confirm=1 +
    // allowDeletedUris header): everything except the still-rejected tracks
    // is merged, and overridden tracks leave the deletion log.
    const confirmed = req.nextUrl.searchParams.get("confirm") === "1";
    const allowHeader = req.headers.get("x-allow-deleted-uris");
    const allowed = new Set<string>(allowHeader ? JSON.parse(allowHeader) as string[] : []);
    const previouslyDeleted = findPreviouslyDeleted(extractUris(csv));
    const rejected = Object.entries(previouslyDeleted)
      .filter(([uri]) => !allowed.has(uri))
      .map(([uri, d]) => ({ uri, name: d.name, artist: d.artist, deletedAt: d.deletedAt }));

    if (!confirmed && rejected.length > 0) {
      return NextResponse.json({ ok: false, needsReview: true, rejected });
    }

    const overridden = Object.keys(previouslyDeleted).filter(uri => allowed.has(uri));
    if (overridden.length > 0) {
      try { removeFromDeletedLog(overridden); } catch (e) { console.warn("[save-default-playlist] deletion log update failed:", e); }
    }

    const incoming = rowsFromUpload(parseCsv(csv));
    const result = mergeTracksIntoPlaylist(csvFile, incoming, { excludeUris: new Set(rejected.map(r => r.uri)) });
    await regenerateCsvFile(csvFile, dest);
    console.log(`[save-default-playlist] appended ${result.appended} rows, merged data into ${result.merged} existing rows in ${dest}${rejected.length ? `, rejected ${rejected.length} previously-deleted` : ""}`);
    // Always heal, even when nothing new was appended: the *existing* rows
    // already on disk (e.g. from a migrated/legacy CSV missing feature
    // columns, or ones just merged above) can still have gaps that need
    // backfilling, independent of whether this request added new rows.
    healInBackground("save-default-playlist");
    return NextResponse.json({ ok: true, ...result, rejected });
  }

  const incoming = rowsFromUpload(parseCsv(csv));
  replaceAllTracks(csvFile, incoming);
  await regenerateCsvFile(csvFile, dest);
  console.log(`[save-default-playlist] replaced library with ${incoming.length} rows from upload (${csv.length} bytes)`);
  healInBackground("save-default-playlist");
  return NextResponse.json({ ok: true });
}
