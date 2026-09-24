import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { parseCsv, matchKey } from "@/lib/csv-store";
import { readAllTracks } from "@/lib/tracks-store";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { findPreviouslyDeletedByName } from "@/lib/deleted-tracks";

// Step 1 of Settings > Playlist Management's "Import tracks (title/artist/
// BPM/genre)" bulk import: parses the uploaded CSV and checks every row
// against the ACTIVE LIBRARY (not just an exact string match — matchKey
// normalizes case/punctuation/parenthetical suffixes, so "Song (Radio Edit)"
// still flags against an existing "Song") and the deleted-tracks log, before
// anything is written or looked up online. The review screen (client) shows
// flagged rows paired with whichever library track(s) they matched, with
// every row checked by default — nothing is silently dropped, the user
// explicitly confirms what actually gets imported via the /confirm route.
//
// Within-batch near-duplicates (two pasted rows that are slight variations
// of the same track, e.g. "New Way (Original Mix)" vs "New Way (Edit)")
// are NOT collapsed — each stays its own candidate, since they may resolve
// to genuinely different Spotify tracks once the online lookup runs. But a
// row that's a genuine EXACT duplicate of another in the same batch (same
// title AND artist, case/whitespace-insensitive — nothing at all to
// differentiate them, e.g. the scrape source listed "Headspace (Original
// Mix) — Mitekiss, Rosie P" twice) IS collapsed to one: the online lookup
// pipeline has no way to tell two identical rows apart either, so keeping
// both would just produce two copies of the same track in the library.

export interface ParsedImportRow {
  index: number;
  title: string;
  artist: string;
  bpm: number | null;
  genre: string | null;
  // Library tracks (by matchKey) this row appears to duplicate — empty if
  // it looks new. Several pasted rows can point at the same library track.
  libraryMatches: { uri: string; name: string; artist: string }[];
  previouslyDeleted: { name: string; artist: string; deletedAt: string } | null;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { csv } = await req.json() as { csv?: string };
  if (!csv?.trim()) return NextResponse.json({ error: "No CSV data" }, { status: 400 });

  const parsed = parseCsv(csv);
  const idx = {
    title: parsed.col("title", "Title", "Track", "Track Name", "Song"),
    artist: parsed.col("artist", "Artist", "Artist Name(s)"),
    bpm: parsed.col("bpm", "BPM", "Tempo"),
    genre: parsed.col("genre", "Genre", "Genres"),
  };
  if (idx.title === -1 || idx.artist === -1) {
    return NextResponse.json({ error: "CSV must have a title/track and artist column" }, { status: 400 });
  }

  const rows: { title: string; artist: string; bpm: number | null; genre: string | null }[] = [];
  // Exact-duplicate collapse key: case/whitespace-insensitive title+artist,
  // WITHOUT matchKey's parenthetical-stripping — "New Way (Original Mix)"
  // and "New Way (Edit)" must stay distinct rows, only a truly identical
  // pair (same title AND artist, nothing to differentiate) collapses.
  const exactKey = (title: string, artist: string) => `${title.trim().toLowerCase()}|||${artist.trim().toLowerCase()}`;
  const seenExact = new Set<string>();
  for (const r of parsed.rows) {
    const title = (r[idx.title] ?? "").trim();
    const artist = (r[idx.artist] ?? "").trim();
    if (!title || !artist) continue;
    const key = exactKey(title, artist);
    if (seenExact.has(key)) continue;
    seenExact.add(key);
    const bpmRaw = idx.bpm !== -1 ? (r[idx.bpm] ?? "").trim() : "";
    const bpm = bpmRaw ? parseFloat(bpmRaw) : null;
    const genre = idx.genre !== -1 ? (r[idx.genre] ?? "").trim() || null : null;
    rows.push({ title, artist, bpm: bpm != null && !isNaN(bpm) ? bpm : null, genre });
  }
  if (rows.length === 0) {
    return NextResponse.json({ error: "No valid rows found in the CSV" }, { status: 400 });
  }

  const csvFile = loadRunningPlaylistConfig().csvFile;
  const libraryRows = readAllTracks(csvFile);
  const libraryByKey = new Map<string, { uri: string; name: string; artist: string }[]>();
  for (const t of libraryRows) {
    if (!t.trackName || !t.artistNames || !t.uri) continue;
    const key = matchKey(t.trackName, t.artistNames);
    const list = libraryByKey.get(key) ?? [];
    list.push({ uri: t.uri, name: t.trackName, artist: t.artistNames });
    libraryByKey.set(key, list);
  }

  const deletedHits = findPreviouslyDeletedByName(rows.map(r => ({ name: r.title, artist: r.artist })));

  const result: ParsedImportRow[] = rows.map((r, i) => ({
    index: i,
    title: r.title,
    artist: r.artist,
    bpm: r.bpm,
    genre: r.genre,
    libraryMatches: libraryByKey.get(matchKey(r.title, r.artist)) ?? [],
    previouslyDeleted: deletedHits.get(i)
      ? { name: deletedHits.get(i)!.name, artist: deletedHits.get(i)!.artist, deletedAt: deletedHits.get(i)!.deletedAt }
      : null,
  }));

  return NextResponse.json({ rows: result });
}
