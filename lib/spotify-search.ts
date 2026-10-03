import { parseRetryAfter, recordSpotifyRequest } from "@/lib/spotify-rate-limit";
import { sleep } from "@/lib/track-enrich";

// Shared "find a Spotify URI by name+artist (or ISRC)" call, throttled and
// rate-limit-aware — factored out of lib/csv-heal.ts's own URI-search phase
// so lib/import-lookup-csv.ts's bulk title/artist/BPM/genre import uses the
// EXACT same throttle/backoff behavior (not a second, slightly-different
// reimplementation of it) — see csv-heal.ts's own `uris` phase for the loop
// that drives this (SearchTokenSource, sleep(400) between calls, switching
// to the secondary Spotify app on a 429 before giving up entirely).

const SPOTIFY_LONG_RATE_LIMIT = Symbol("spotify-long-rate-limit");
export interface SpotifyRateLimited { kind: typeof SPOTIFY_LONG_RATE_LIMIT; retryAt: string }

export function isSpotifyRateLimited(v: unknown): v is SpotifyRateLimited {
  return typeof v === "object" && v !== null && (v as SpotifyRateLimited).kind === SPOTIFY_LONG_RATE_LIMIT;
}

// "New Way (Original Mix)" -> "New Way" — a scrape/tracklist title often
// carries a mix/edit suffix in brackets that Spotify's own search doesn't
// always match verbatim. Strips (), [] and their contents, plus a trailing
// " - Suffix" (the other common convention), and any leftover whitespace.
// Returns null if there was nothing to strip, so callers can tell "already
// tried the bare title" from "nothing left to try" and avoid a wasted
// identical second search.
export function stripBracketedSuffix(title: string): string | null {
  const stripped = title
    .replace(/\s*[([][^)\]]*[)\]]\s*/g, " ")
    .replace(/\s+-\s+[^-]+$/, "")
    .trim();
  return stripped && stripped !== title.trim() ? stripped : null;
}

async function searchOnce(query: string, token: string): Promise<string | null | SpotifyRateLimited> {
  recordSpotifyRequest();
  let res = await fetch(`https://api.spotify.com/v1/search?q=${query}&type=track&limit=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 429) {
    const wait = parseRetryAfter(res.headers.get("Retry-After") ?? "30");
    const retryAt = new Date(Date.now() + wait * 1000).toISOString();
    console.log(`[spotify-search] 429 — retry-after ${wait}s`);
    if (wait > 10) return { kind: SPOTIFY_LONG_RATE_LIMIT, retryAt };
    await sleep(wait * 1000);
    recordSpotifyRequest();
    res = await fetch(`https://api.spotify.com/v1/search?q=${query}&type=track&limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }
  if (!res.ok) return null;
  const data = await res.json() as { tracks?: { items?: { uri?: string }[] } };
  return data.tracks?.items?.[0]?.uri ?? null;
}

// A multi-artist CSV field ("Emery, Dreazz, Physics (Dnb)") joins every
// collaborator with a comma, sometimes with a trailing genre/style tag in
// brackets tacked on by the scrape source — neither belongs in Spotify's
// `artist:` filter, which matches against ONE artist name. Searching with
// the whole literal string ("artist:Emery, Dreazz, Physics (Dnb)") reliably
// finds nothing even though the track is really on Spotify under any one of
// those names. Strips a trailing "(...)"/"[...]" tag, then takes the first
// comma-separated name — good enough for the search filter; the full
// multi-artist string is still what gets stored/displayed, this is only
// used to build the query.
function primarySearchArtist(artist: string): string {
  const noTag = artist.replace(/\s*[([][^)\]]*[)\]]\s*$/, "").trim();
  return (noTag || artist).split(",")[0].trim();
}

// Finds a Spotify track URI for a row that has none. Prefers an exact ISRC
// search (`isrc:{isrc}`) when the row has one — a precise single-recording
// match, no fuzzy title/artist guessing — falling back to name + artist
// otherwise. If a plain name+artist search (no ISRC) finds nothing AND the
// title has a bracketed/dash suffix (e.g. "(Original Mix)"), retries once
// more with that suffix stripped — every caller of this function (the
// heal sweep's own uris phase, and the title/artist/BPM/genre bulk import)
// gets this fallback automatically, rather than each reimplementing it. A
// >10s Retry-After returns the rate-limit sentinel so the caller can switch
// apps or back off instead of blocking on a long sleep; a short one is
// waited out and retried once inline. Only the top result is used — good
// enough for the common case, same trade-off the BBC cron's search already
// makes.
export async function spotifySearchUri(name: string, artist: string, token: string, isrc?: string | null): Promise<string | null | SpotifyRateLimited> {
  // A "pending:<uuid>" isrc is the bulk-import's own placeholder (see
  // app/api/tracks/import-lookup-csv/confirm/route.ts), written to the row
  // when neither Deezer/ReccoBeats nor Spotify could resolve a real one at
  // import time — never a genuine ISRC. Searching `isrc:pending:...` always
  // returns nothing, and worse, short-circuits past the name+artist search
  // below every time this row comes up in a later heal sweep, permanently
  // stranding it with no URI. Treat it as absent instead.
  const realIsrc = isrc && !isrc.startsWith("pending:") ? isrc : null;
  if (realIsrc) {
    return searchOnce(encodeURIComponent(`isrc:${realIsrc}`), token);
  }
  const searchArtist = primarySearchArtist(artist);
  const first = await searchOnce(encodeURIComponent(`track:${name} artist:${searchArtist}`), token);
  if (first || isSpotifyRateLimited(first)) return first;

  const stripped = stripBracketedSuffix(name);
  if (!stripped) return first; // nothing left to try — first is null here

  await sleep(400); // same conservative gap the calling loops use between tracks
  return searchOnce(encodeURIComponent(`track:${stripped} artist:${searchArtist}`), token);
}
