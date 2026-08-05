// Canonical shape for a row in the `tracks` table (lib/db.ts) — the
// DB-backed replacement for the ad-hoc string[] column-index access every
// CSV consumer used to do. Field names map 1:1 to the CSV's 24 columns
// (Track URI -> uri, Artist Name(s) -> artistNames, etc.), preserved as
// nullable rather than defaulted so "missing" stays distinguishable from
// "present but zero/empty" (the CSV-heal sweep depends on this).
export interface TrackRow {
  csvFile: string;
  uri: string;              // '' for legacy rows with no Track URI at all
  rowNo: number;             // 1-based original CSV row order; also disambiguates blank-uri rows
  trackName: string | null;
  albumName: string | null;
  artistNames: string | null;
  releaseDate: string | null;
  durationMs: number | null;
  popularity: number | null;
  explicit: string | null;
  addedBy: string | null;
  addedAt: string | null;
  genres: string | null;
  recordLabel: string | null;
  danceability: number | null;
  energy: number | null;
  key: number | null;
  loudness: number | null;
  mode: number | null;
  speechiness: number | null;
  acousticness: number | null;
  instrumentalness: number | null;
  liveness: number | null;
  valence: number | null;
  tempo: number | null;
  timeSignature: number | null;
  // Set only for a track added via ISRC before its real Spotify URI is
  // known (e.g. "search more by this artist" results, resolved from Deezer
  // rather than a Spotify search) — the heal sweep uses this to resolve the
  // URI later via `isrc:{isrc}` search. Null for every normally-added track.
  isrc: string | null;
}
