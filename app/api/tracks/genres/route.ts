import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readAllTracks } from "@/lib/tracks-store";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { GENRE_HIERARCHY, isMappedGenreTag } from "@/lib/genre-hierarchy";

// Distinct genre tags across the active library — Dashboard's "🎧 Remix…"
// right-click "genre-restricted remix" picker (only tracks tagged with the
// checked genres are sent as candidates to the existing remix flow, via
// /api/tracks/genre-uris). Same comma-separated, lowercase-normalized
// Genres column parsing as lib/genre-artists.ts's parseGenres, kept as a
// separate small copy here rather than importing it since that module's
// own parseGenres is a plain module-private function, not exported for
// reuse across an arbitrary track set — this route only needs the parsing
// rule, not that module's genre-picks-artists Deezer-search logic.
function parseGenres(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(",").map(g => g.trim().toLowerCase()).filter(Boolean);
}

interface GenreEntry { genre: string; count: number }

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const rows = readAllTracks(loadRunningPlaylistConfig().csvFile);
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const g of parseGenres(row.genres)) {
        counts.set(g, (counts.get(g) ?? 0) + 1);
      }
    }
    // Alphabetical, not by count — the flat list (still used by the picker's
    // own filter-box matching) is meant to be scanned/searched by name, not
    // browsed by popularity.
    const genres: GenreEntry[] = Array.from(counts.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([genre, count]) => ({ genre, count }));

    // 3-tier hierarchy (main genre -> subgenre -> tags), built from the
    // hand-placed lib/genre-hierarchy.ts mapping plus this library's own
    // live counts — a tag only appears if the library actually has it
    // (count > 0), so an empty branch never shows up. Any real tag NOT
    // covered by that mapping falls into a synthetic "Other" main genre
    // (a flat "Uncategorized" subgenre) instead of silently disappearing
    // from the tree — keeps a newly-enriched tag visible/selectable even
    // before genre-hierarchy.ts is updated to place it properly.
    const hierarchy = Object.entries(GENRE_HIERARCHY).map(([mainGenre, subgenres]) => ({
      mainGenre,
      subgenres: Object.entries(subgenres).map(([subgenre, tags]) => ({
        subgenre,
        tags: tags.filter(t => counts.has(t)).map(t => ({ genre: t, count: counts.get(t)! })),
      })).filter(sg => sg.tags.length > 0),
    })).filter(mg => mg.subgenres.length > 0);

    const uncategorized: GenreEntry[] = genres.filter(g => !isMappedGenreTag(g.genre));
    if (uncategorized.length > 0) {
      hierarchy.push({ mainGenre: "Other", subgenres: [{ subgenre: "Uncategorized", tags: uncategorized }] });
    }

    return NextResponse.json({ genres, hierarchy });
  } catch {
    return NextResponse.json({ genres: [], hierarchy: [] });
  }
}
