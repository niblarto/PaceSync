import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { activeCsvPath } from "@/lib/running-playlist-config";
import { readCsv, writeCsv } from "@/lib/csv-store";
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

  const csvPath = activeCsvPath();
  try {
    const { headers, rows, col } = await readCsv(csvPath);
    const idxUri = col("Track URI");
    const idxName = col("Track Name");
    const idxArtist = col("Artist Name(s)");
    const removedRows: { uri: string; name?: string; artist?: string }[] = [];
    const kept: string[][] = [];
    for (const row of rows) {
      const uri = idxUri !== -1 ? row[idxUri]?.trim() : undefined;
      if (uri && fullUris.has(uri)) {
        removedRows.push({
          uri,
          name: idxName !== -1 ? row[idxName]?.trim() : undefined,
          artist: idxArtist !== -1 ? row[idxArtist]?.trim() : undefined,
        });
      } else {
        kept.push(row);
      }
    }
    if (removedRows.length > 0) {
      await writeCsv(csvPath, headers, kept);
      // Log deletions so import paths can flag/reject these tracks if they
      // ever come back via BBC episodes, CSV appends, or the weekly cron.
      try { recordDeletedTracks(removedRows); } catch (e) { console.warn("[tracks/delete] deletion log failed:", e); }
      // A pinned mix containing a just-deleted track no longer matches
      // reality — unpin it regardless of which mix (if any) happens to be
      // loaded client-side, since the deleted track could belong to ANY
      // pinned date's mix, not just whatever's currently on screen.
      try {
        const unpinned = await unpinMixesContaining(Array.from(fullUris), Date.now());
        // Only clears the saved-history snapshot for a run that's ALREADY
        // outside the Runna summary card's window (unpinMixesContaining
        // itself only ever unpins upcoming workouts, but a run still
        // showing on the summary card should keep its tracklist regardless
        // — protectRecentRuns is the guard for that).
        for (const { date, title } of unpinned) removeTodaysRunEntry(date, title, { protectRecentRuns: true });
      } catch (e) { console.warn("[tracks/delete] pin invalidation failed:", e); }
      return NextResponse.json({ ok: true, csvRemoved: true, removed: removedRows.length });
    }
    return NextResponse.json({ ok: true, csvRemoved: false, removed: 0 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
