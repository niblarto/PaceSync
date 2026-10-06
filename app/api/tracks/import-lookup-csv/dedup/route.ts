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
  // Spotify URI, when the source CSV supplied one (e.g. a Chosic export's
  // "Spotify URL" column) — normalized to spotify:track:<id>. When present,
  // /confirm uses this DIRECTLY instead of a fuzzy title/artist search,
  // since the source already named the exact track (a search can land on
  // the wrong same-titled track, confirmed live with a "Clint Eastwood" by
  // Gorillaz mismatch — this sidesteps that failure mode entirely whenever
  // the CSV already supplies ground truth).
  uri: string | null;
  // Library tracks (by matchKey, or by exact URI when the row has one —
  // whichever finds more/better matches) this row appears to duplicate —
  // empty if it looks new. Several pasted rows can point at the same
  // library track.
  libraryMatches: { uri: string; name: string; artist: string }[];
  previouslyDeleted: { name: string; artist: string; deletedAt: string } | null;
}

// A Spotify track URL ("https://open.spotify.com/track/<id>?si=...") or a
// bare "spotify:track:<id>" URI, as several export sources (Chosic, Exportify-
// adjacent tools) include alongside title/artist — normalized to the
// spotify:track:<id> form used everywhere else in this app.
function parseSpotifyUriCell(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const urlMatch = trimmed.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/);
  if (urlMatch) return `spotify:track:${urlMatch[1]}`;
  const uriMatch = trimmed.match(/^spotify:track:([A-Za-z0-9]+)$/);
  if (uriMatch) return `spotify:track:${uriMatch[1]}`;
  // A bare 22-char base62 id with nothing else recognizable — Spotify's own
  // id length - accepted so a CSV with just an "id"/"Track ID" column (no
  // full URL/URI) still works.
  if (/^[A-Za-z0-9]{22}$/.test(trimmed)) return `spotify:track:${trimmed}`;
  return null;
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
    uri: parsed.col("Spotify URL", "Spotify URI", "Track URI", "spotify url", "spotify uri", "uri", "url", "Track ID", "track id"),
  };
  if (idx.title === -1 || idx.artist === -1) {
    return NextResponse.json({ error: "CSV must have a title/track and artist column" }, { status: 400 });
  }

  const rows: { title: string; artist: string; bpm: number | null; genre: string | null; uri: string | null }[] = [];
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
    const uri = idx.uri !== -1 ? parseSpotifyUriCell(r[idx.uri] ?? "") : null;
    rows.push({ title, artist, bpm: bpm != null && !isNaN(bpm) ? bpm : null, genre, uri });
  }
  if (rows.length === 0) {
    return NextResponse.json({ error: "No valid rows found in the CSV" }, { status: 400 });
  }

  const csvFile = loadRunningPlaylistConfig().csvFile;
  const libraryRows = readAllTracks(csvFile);
  const libraryByKey = new Map<string, { uri: string; name: string; artist: string }[]>();
  const libraryByUri = new Map<string, { uri: string; name: string; artist: string }>();
  for (const t of libraryRows) {
    if (!t.trackName || !t.artistNames || !t.uri) continue;
    const entry = { uri: t.uri, name: t.trackName, artist: t.artistNames };
    const key = matchKey(t.trackName, t.artistNames);
    const list = libraryByKey.get(key) ?? [];
    list.push(entry);
    libraryByKey.set(key, list);
    libraryByUri.set(t.uri, entry);
  }

  const deletedHits = findPreviouslyDeletedByName(rows.map(r => ({ name: r.title, artist: r.artist })));

  const result: ParsedImportRow[] = rows.map((r, i) => {
    // A row with a supplied URI is matched by that URI FIRST (the
    // authoritative signal — two different library rows can share a loose
    // matchKey, e.g. "Clint Eastwood" by two different Gorillaz catalog
    // entries, but a URI match is exact) and only falls back to the loose
    // title/artist matchKey when the row has no URI of its own.
    const byUri = r.uri ? libraryByUri.get(r.uri) : undefined;
    const libraryMatches = byUri ? [byUri] : (libraryByKey.get(matchKey(r.title, r.artist)) ?? []);
    return {
      index: i,
      title: r.title,
      artist: r.artist,
      bpm: r.bpm,
      genre: r.genre,
      uri: r.uri,
      libraryMatches,
      previouslyDeleted: deletedHits.get(i)
        ? { name: deletedHits.get(i)!.name, artist: deletedHits.get(i)!.artist, deletedAt: deletedHits.get(i)!.deletedAt }
        : null,
    };
  });

  return NextResponse.json({ rows: result });
}
