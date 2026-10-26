import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { activeCsvPath, loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { readTracksByUris, deleteTracksByUri, regenerateCsvFile } from "@/lib/tracks-store";
import { recordDeletedTracks } from "@/lib/deleted-tracks";
import { findBrokenTracklists } from "@/lib/broken-tracklists";
import { ensureSpotifyRemovalsStarted, queueSpotifyRemovals } from "@/lib/spotify-removals";

// Library (CSV) deletion. The Spotify playlist removal is QUEUED here (lib/spotify-removals.ts: batched,
// kept on disk and retried after a rate limit) rather than sent from the browser and forgotten.
// Accepts either a single spotifyUri (back-compat) or a spotifyUris batch, doing one
// CSV read/write for the whole batch instead of a round-trip per track.
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { spotifyUri, spotifyUris, skipDeletedLog } = await req.json() as { spotifyUri?: string; spotifyUris?: string[]; skipDeletedLog?: boolean };
  const uris = spotifyUris?.length ? spotifyUris : (spotifyUri ? [spotifyUri] : []);
  if (uris.length === 0) return NextResponse.json({ error: "Missing spotifyUri(s)" }, { status: 400 });

  // Match by exact full URI, not a substring track-id pre-filter — a bare
  // id could in principle be a substring of an unrelated row's id/other
  // cell, which the old line.includes(id) check didn't guard against.
  const fullUris = new Set(uris.map(u => u.startsWith("spotify:track:") ? u : `spotify:track:${u}`));

  const csvFile = loadRunningPlaylistConfig().csvFile;
  // Queue the removal from the Spotify playlist whether or not the CSV still has the row: a
  // track already gone from the library can still be on the playlist.
  ensureSpotifyRemovalsStarted();
  queueSpotifyRemovals(Array.from(fullUris));
  try {
    const matched = readTracksByUris(csvFile, Array.from(fullUris));
    const removedRows: { uri: string; name?: string; artist?: string }[] = matched.map(t => ({
      uri: t.uri,
      name: t.trackName ?? undefined,
      artist: t.artistNames ?? undefined,
    }));
    if (removedRows.length > 0) {
      deleteTracksByUri(csvFile, removedRows.map(r => r.uri));
      await regenerateCsvFile(csvFile, activeCsvPath());
      // Log deletions so import paths can flag/reject these tracks if they
      // ever come back via BBC episodes, CSV appends, or the weekly cron —
      // skipped for a duplicate-cleanup delete (Settings' "Possible
      // duplicates" card): that's just removing a redundant copy of a song
      // the library still legitimately has under its other URI, not a "never
      // bring this track back" decision, so it shouldn't get blacklisted.
      if (!skipDeletedLog) {
        try { recordDeletedTracks(removedRows); } catch (e) { console.warn("[tracks/delete] deletion log failed:", e); }
      }
      // Mixes containing the deleted track are left exactly as they are —
      // no unpinning, no wiped tracklist. The track shows highlighted in
      // them, and the broken-tracklist banner / daily check (lib/broken-
      // tracklists.ts) list them until each is repaired with a swap.
      // `affected` lets the caller show that straight away.
      let affected: ReturnType<typeof findBrokenTracklists> = [];
      try {
        affected = findBrokenTracklists().filter(b => b.missing.some(m => fullUris.has(m.uri)));
      } catch (e) { console.warn("[tracks/delete] broken-tracklist scan failed:", e); }
      return NextResponse.json({ ok: true, csvRemoved: true, removed: removedRows.length, affected });
    }
    return NextResponse.json({ ok: true, csvRemoved: false, removed: 0 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
