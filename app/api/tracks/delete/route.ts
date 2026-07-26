import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile, writeFile } from "fs/promises";
import { activeCsvPath } from "@/lib/running-playlist-config";
import { parseCsvRow } from "@/lib/csv-merge";
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

  const trackIds = Array.from(new Set(uris.map(u => u.startsWith("spotify:track:") ? u.slice("spotify:track:".length) : u)));

  const csvPath = activeCsvPath();
  try {
    const csv = await readFile(csvPath, "utf8");
    const lines = csv.split("\n");
    const before = lines.length;
    const headers = parseCsvRow(lines[0].replace(/^﻿/, "")).map(h => h.trim());
    const idxUri = headers.indexOf("Track URI");
    const idxName = headers.indexOf("Track Name");
    const idxArtist = headers.indexOf("Artist Name(s)");
    const removedRows: { uri: string; name?: string; artist?: string }[] = [];
    const filtered = lines.filter((line, i) => {
      if (i === 0) return true;
      const hit = trackIds.some(id => line.includes(id));
      if (hit) {
        const row = parseCsvRow(line);
        const uri = idxUri !== -1 ? row[idxUri]?.trim() : undefined;
        if (uri) {
          removedRows.push({
            uri,
            name: idxName !== -1 ? row[idxName]?.trim() : undefined,
            artist: idxArtist !== -1 ? row[idxArtist]?.trim() : undefined,
          });
        }
      }
      return !hit;
    });
    if (filtered.length < before) {
      await writeFile(csvPath, filtered.join("\n"), "utf8");
      // Log deletions so import paths can flag/reject these tracks if they
      // ever come back via BBC episodes, CSV appends, or the weekly cron.
      try { recordDeletedTracks(removedRows); } catch (e) { console.warn("[tracks/delete] deletion log failed:", e); }
      // A pinned mix containing a just-deleted track no longer matches
      // reality — unpin it regardless of which mix (if any) happens to be
      // loaded client-side, since the deleted track could belong to ANY
      // pinned date's mix, not just whatever's currently on screen.
      try {
        const deletedUris = uris.map(u => u.startsWith("spotify:track:") ? u : `spotify:track:${u}`);
        const unpinnedDates = unpinMixesContaining(deletedUris);
        for (const date of unpinnedDates) removeTodaysRunEntry(date);
      } catch (e) { console.warn("[tracks/delete] pin invalidation failed:", e); }
      return NextResponse.json({ ok: true, csvRemoved: true, removed: before - filtered.length });
    }
    return NextResponse.json({ ok: true, csvRemoved: false, removed: 0 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
