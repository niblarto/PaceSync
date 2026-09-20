import type { TrackRow } from "@/types/track";

// "Search online by genre" (Dashboard's replace-by-BPM ♻ feature) doesn't
// use a real genre search — Deezer has none: its /genre list is ~20 broad
// categories (Pop, Rock, Electro, …), no "Liquid Drum and Bass", and its
// search's genre: field filter turned out to just be a plain-text match
// against track titles, not real genre metadata (confirmed by testing it
// directly). Instead, this uses the LIBRARY's own Genres column (already
// populated per-track by the existing Deezer-album enrichment, see
// lib/track-enrich.ts) to find OTHER artists tagged with at least one genre
// in common with the track being replaced, and searches those artists'
// Deezer catalogs (deezerArtistTopTracks) the same way the "own artist"
// seed already does — genre picks WHICH ARTISTS to search, not a genre
// filter on tracks directly.

// Genres column is a comma-separated list, e.g. "jungle,drum and bass,
// liquid funk" — case can vary between rows (some all-lowercase, some
// Title Case from an older enrichment pass), so compare case-insensitively.
function parseGenres(raw: string | null): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(",").map(g => g.trim().toLowerCase()).filter(Boolean));
}

// Other artists (excluding excludeArtists, case-insensitive) sharing at
// least one genre tag with seedGenres — ranked by how many OTHER same-
// genre tracks that artist has in the library (a rough "how central to this
// genre" signal), deduped, capped at maxArtists so a genre with hundreds of
// tagged tracks doesn't turn into hundreds of online searches.
export function artistsSharingGenre(
  rows: Pick<TrackRow, "artistNames" | "genres">[],
  seedGenres: Set<string>,
  excludeArtists: string | string[],
  maxArtists: number,
): string[] {
  if (seedGenres.size === 0) return [];
  const excludeSet = new Set((Array.isArray(excludeArtists) ? excludeArtists : [excludeArtists]).map(a => a.trim().toLowerCase()));
  const counts = new Map<string, { name: string; count: number }>();
  for (const row of rows) {
    const artist = row.artistNames?.split(",")[0]?.trim(); // primary artist only, same convention as the rest of this app
    if (!artist || excludeSet.has(artist.toLowerCase())) continue;
    const genres = parseGenres(row.genres);
    if (!Array.from(genres).some(g => seedGenres.has(g))) continue;
    const key = artist.toLowerCase();
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { name: artist, count: 1 });
  }
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, maxArtists)
    .map(a => a.name);
}

export { parseGenres };
