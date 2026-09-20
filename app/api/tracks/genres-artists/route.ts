import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readAllTracks } from "@/lib/tracks-store";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";

// Distinct genre tags and (primary) artist names in the active library —
// backs the Dashboard's replace-by-BPM ♻ picker's "search by artist/genre"
// typeahead. Genres column is comma-separated per track (see
// lib/genre-artists.ts); returned genres are deduped case-insensitively but
// keep one representative original casing for display.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = readAllTracks(loadRunningPlaylistConfig().csvFile);

  const genreDisplay = new Map<string, string>(); // lowercase -> first-seen original casing
  const artists = new Set<string>();
  for (const row of rows) {
    const artist = row.artistNames?.split(",")[0]?.trim();
    if (artist) artists.add(artist);
    if (row.genres) {
      for (const g of row.genres.split(",")) {
        const trimmed = g.trim();
        if (!trimmed) continue;
        const lower = trimmed.toLowerCase();
        if (!genreDisplay.has(lower)) genreDisplay.set(lower, trimmed);
      }
    }
  }
  return NextResponse.json({
    genres: Array.from(genreDisplay.values()).sort((a, b) => a.localeCompare(b)),
    artists: Array.from(artists).sort((a, b) => a.localeCompare(b)),
  });
}
