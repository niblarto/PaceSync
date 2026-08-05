// Shared audio-feature enrichment: ReccoBeats (free, keyless) accepts Spotify
// track IDs directly in /v1/audio-features and returns an open.spotify.com
// href we can map back to the requested ID. For IDs ReccoBeats doesn't know,
// fall back to resolving an ISRC via Deezer search (artist + title) —
// ReccoBeats accepts ISRCs in the same endpoint. Mirrors the bpm_matcher
// Python pipeline. Used by /api/bpm/enrich and the CSV heal sweep.

const BATCH = 40;
const DEEZER_FALLBACK_CAP = 30; // per request — Deezer is rate limited (50 req / 5 s)

export const UA = "pacesync/0.1 (running playlist tool)";

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface TrackQuery {
  id: string;
  name?: string;
  artist?: string;
}

interface ReccoFeature {
  href?: string;
  isrc?: string;
  tempo?: number;
  key?: number;
  mode?: number;
  energy?: number;
  danceability?: number;
  valence?: number;
}

export interface TrackFeatures {
  tempo: number;
  key: number;
  mode: number;
  energy: number;
  danceability: number;
  valence: number;
}

function spotifyIdFromHref(href: string | undefined): string | null {
  const m = href?.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

function toFeatures(f: ReccoFeature): TrackFeatures | null {
  if (f.tempo == null) return null;
  return {
    tempo: Math.round(f.tempo * 1000) / 1000,
    key: f.key ?? -1,
    mode: f.mode ?? 0,
    energy: f.energy ?? 0.5,
    danceability: f.danceability ?? 0.5,
    valence: f.valence ?? 0.5,
  };
}

async function reccoBatch(ids: string[]): Promise<ReccoFeature[]> {
  const out: ReccoFeature[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const res = await fetch(
      `https://api.reccobeats.com/v1/audio-features?ids=${ids.slice(i, i + BATCH).join(",")}`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) },
    );
    if (!res.ok) throw new Error(`ReccoBeats ${res.status}`);
    const data = await res.json() as { content?: ReccoFeature[] };
    out.push(...(data.content ?? []));
  }
  return out;
}

// Exported for callers that need just the ISRC lookup on its own (e.g.
// app/api/bbc/tracks's Spotify-free matching path) rather than going
// through fetchFeatures' Spotify-ID-keyed flow.
export async function deezerIsrc(name: string, artist: string): Promise<string | null> {
  const tryQuery = async (q: string): Promise<number | null> => {
    const res = await fetch(`https://api.deezer.com/search?q=${q}&limit=1`, {
      headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const d = await res.json() as { data?: { id?: number }[] };
    return d.data?.[0]?.id ?? null;
  };

  let id = await tryQuery(encodeURIComponent(`artist:"${artist}" track:"${name}"`));
  if (!id) {
    await sleep(150);
    id = await tryQuery(encodeURIComponent(`${artist} ${name}`));
  }
  if (!id) return null;

  await sleep(150);
  const res = await fetch(`https://api.deezer.com/track/${id}`, {
    headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const t = await res.json() as { isrc?: string };
  return t.isrc || null;
}

// Deezer track duration (seconds) by artist + title — keyless fallback for
// rows missing Duration (ms) when no Spotify app token is available.
export async function deezerDurationMs(name: string, artist: string): Promise<number | null> {
  const q = encodeURIComponent(`artist:"${artist}" track:"${name}"`);
  const res = await fetch(`https://api.deezer.com/search?q=${q}&limit=1`, {
    headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const d = await res.json() as { data?: { duration?: number }[] };
  const secs = d.data?.[0]?.duration;
  return typeof secs === "number" && secs > 0 ? secs * 1000 : null;
}

// Deezer genre names for a track, via its album (Deezer attaches genre to
// the album, not the track or artist) — keyless fallback for the Genres
// column now that Spotify's artist endpoint no longer returns genres for
// newer apps. Comma-joined to match how the CSV's Genres column is written
// elsewhere (Exportify's convention).
//
// Same two-tier query as deezerIsrc: the quoted artist:"X" track:"Y" form
// is precise but brittle — decorated titles ("Song - Remix Name") or
// certain artist names return zero results even when Deezer clearly has
// the track (confirmed empirically: Chairlift/Goldroom tracks 0-result on
// the quoted query, found immediately on the plain one). The loose
// fallback trades a little precision for actually finding the track.
export async function deezerGenres(name: string, artist: string): Promise<string | null> {
  const tryQuery = async (q: string): Promise<number | null> => {
    const res = await fetch(`https://api.deezer.com/search?q=${q}&limit=1`, {
      headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const d = await res.json() as { data?: { album?: { id?: number } }[] };
    return d.data?.[0]?.album?.id ?? null;
  };

  let albumId = await tryQuery(encodeURIComponent(`artist:"${artist}" track:"${name}"`));
  if (!albumId) {
    await sleep(150);
    albumId = await tryQuery(encodeURIComponent(`${artist} ${name}`));
  }
  if (!albumId) return null;

  await sleep(150);
  const albumRes = await fetch(`https://api.deezer.com/album/${albumId}`, {
    headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000),
  });
  if (!albumRes.ok) return null;
  const album = await albumRes.json() as { genres?: { data?: { name?: string }[] } };
  const names = (album.genres?.data ?? []).map(g => g.name).filter((n): n is string => !!n);
  return names.length > 0 ? names.join(", ") : null;
}

// Last.fm track.getInfo duration (ms) — needs LASTFM_API_KEY; last-resort
// duration source after Spotify and Deezer. Last.fm has no BPM/key data,
// so it only helps with durations.
export async function lastfmDurationMs(name: string, artist: string): Promise<number | null> {
  const key = process.env.LASTFM_API_KEY;
  if (!key) return null;
  const params = new URLSearchParams({
    method: "track.getInfo", api_key: key, format: "json",
    track: name, artist, autocorrect: "1",
  });
  const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`, {
    headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const d = await res.json() as { track?: { duration?: string } };
  const ms = parseInt(d.track?.duration ?? "", 10);
  return !isNaN(ms) && ms > 0 ? ms : null;
}

export interface IsrcResolution extends TrackFeatures {
  uri: string; // spotify:track:{id}, taken from ReccoBeats' href — see note below
}

// Resolves BOTH a playable Spotify URI and audio features directly from an
// ISRC via ReccoBeats — no Spotify API call at all. Querying ReccoBeats by
// ISRC returns one entry per Spotify track sharing that ISRC (different
// releases/reissues of the same recording carry the same ISRC); audio
// features are effectively identical across entries (same actual
// recording), so the first entry's href is used as "the" URI. This is a
// deliberate trade-off: the picked release might occasionally differ from
// whichever one Spotify's own text search would surface, but it's always
// the same song, and it means this path never touches Spotify's Search API
// at all — used by "search more by this artist" (components/
// DashboardClient.tsx's searchArtistTopTracks) specifically because that
// feature's old per-track Spotify search was the confirmed trigger of
// repeated real rate-limit bans.
export async function resolveByIsrc(isrc: string): Promise<IsrcResolution | null> {
  const res = await fetch(`https://api.reccobeats.com/v1/audio-features?ids=${encodeURIComponent(isrc)}`, {
    headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return null;
  const data = await res.json() as { content?: ReccoFeature[] };
  const first = data.content?.[0];
  if (!first) return null;
  const trackId = spotifyIdFromHref(first.href);
  const feat = toFeatures(first);
  if (!trackId || !feat) return null;
  return { ...feat, uri: `spotify:track:${trackId}` };
}

// Resolves audio features for the given Spotify track IDs, keyed by ID.
// Throws only when nothing at all could be fetched; otherwise returns
// whatever resolved.
export async function fetchFeatures(queries: TrackQuery[]): Promise<Record<string, TrackFeatures>> {
  const features: Record<string, TrackFeatures> = {};
  try {
    // Pass 1: direct Spotify ID lookup
    for (const f of await reccoBatch(queries.map(q => q.id))) {
      const id = spotifyIdFromHref(f.href);
      const feat = id ? toFeatures(f) : null;
      if (id && feat) features[id] = feat;
    }

    // Pass 2: Deezer → ISRC → ReccoBeats for anything still missing
    const missing = queries.filter(q => !features[q.id] && q.name && q.artist);
    const isrcToId = new Map<string, string>();
    for (const q of missing.slice(0, DEEZER_FALLBACK_CAP)) {
      try {
        const isrc = await deezerIsrc(q.name!, q.artist!);
        if (isrc) isrcToId.set(isrc, q.id);
      } catch { /* skip this track */ }
      await sleep(150);
    }
    if (isrcToId.size > 0) {
      for (const f of await reccoBatch(Array.from(isrcToId.keys()))) {
        const id = f.isrc ? isrcToId.get(f.isrc) : null;
        const feat = id ? toFeatures(f) : null;
        if (id && feat && !features[id]) features[id] = feat;
      }
    }
  } catch (err) {
    // Partial results beat failing wholesale
    if (Object.keys(features).length === 0) throw err;
  }
  return features;
}
