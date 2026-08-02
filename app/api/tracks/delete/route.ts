import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { activeCsvPath, loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { readTracksByUris, deleteTracksByUri, regenerateCsvFile } from "@/lib/tracks-store";
import { recordDeletedTracks } from "@/lib/deleted-tracks";
import { unpinMixesContaining } from "@/lib/pinned-mixes";
import { removeTodaysRunEntry } from "@/lib/todays-run-history";

// CSV-only deletion — Spotify removal is handled client-side with the browser token.
// Accepts either a single spotifyUri (back-compat) or a spotifyUris batch, doing one
// CSV read/write for the whole batch instead of a round-trip per track.
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { spotifyUri, spotifyUris } = await req.json() as { spotifyUri?: string; spotifyUris?: string[] };
  const uris = spotifyUris?.length ? spotifyUris : (spotifyUri ? [spotifyUri] : []);
  if (uris.length === 0) return NextResponse.json({ error: "Missing spotifyUri(s)" }, { status: 400 });

  // Match by exact full URI, not a substring track-id pre-filter — a bare
  // id could in principle be a substring of an unrelated row's id/other
  // cell, which the old line.includes(id) check didn't guard against.
  const fullUris = new Set(uris.map(u => u.startsWith("spotify:track:") ? u : `spotify:track:${u}`));

  const csvFile = loadRunningPlaylistConfig().csvFile;
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
      // ever come back via BBC episodes, CSV appends, or the weekly cron.
      try { recordDeletedTracks(removedRows); } catch (e) { console.warn("[tracks/delete] deletion log failed:", e); }
      // A pinned mix containing a just-deleted track no longer matches
      // reality — unpin it regardless of which mix (if any) happens to be
      // loaded client-side, since the deleted track could belong to ANY
      // pinned date's mix, not just whatever's currently on screen.
      try {
        const unpinned = await unpinMixesContaining(Array.from(fullUris), Date.now());
        // removeTodaysRunEntry itself now unconditionally refuses to delete
        // any past-or-today-dated row — a run's tracklist is a permanent
        // record once it's happened, regardless of which caller asks.
        for (const { date, title } of unpinned) removeTodaysRunEntry(date, title);
      } catch (e) { console.warn("[tracks/delete] pin invalidation failed:", e); }
      return NextResponse.json({ ok: true, csvRemoved: true, removed: removedRows.length });
    }
    return NextResponse.json({ ok: true, csvRemoved: false, removed: 0 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
