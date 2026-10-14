import { readAllTracks } from "@/lib/tracks-store";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { findPreviouslyDeleted } from "@/lib/deleted-tracks";
import { getFreshToken } from "@/lib/tokenStore";
import { addTracksToLibrary } from "@/lib/library-add";
import { healActiveCsv } from "@/lib/csv-heal";
import { UA, sleep } from "@/lib/track-enrich";

// Track Lookup (Settings > Tracklist, under the Song Crawler): searches
// Deezer for an artist + title and returns everything Deezer and ReccoBeats
// know about each match. Nothing is written unless the user picks "Add to
// playlist", which adds the track to the library and the Spotify playlist.
// Never uses Spotify Search (429 bans) — the Spotify URI comes from
// ReccoBeats by ISRC, same as the Song Crawler.

const MAX_RESULTS = 10;
const DEEZER_GAP_MS = 120; // Deezer allows 50 requests / 5 s

export interface LookupFeatures {
  tempo: number | null;
  key: number | null;
  mode: number | null;
  energy: number | null;
  danceability: number | null;
  valence: number | null;
  acousticness: number | null;
  instrumentalness: number | null;
  liveness: number | null;
  loudness: number | null;
  speechiness: number | null;
}

export interface LookupResult {
  deezerId: number;
  title: string;
  artist: string;
  contributors: string[];
  album: string | null;
  albumType: string | null;
  label: string | null;
  genres: string[];
  releaseDate: string | null;
  trackPosition: number | null;
  discNumber: number | null;
  durationSec: number | null;
  deezerBpm: number | null;
  gain: number | null;
  explicit: boolean;
  rank: number | null;
  isrc: string | null;
  cover: string | null;
  preview: string | null;
  deezerUrl: string | null;
  spotifyUri: string | null;
  features: LookupFeatures | null;
  /** Deezer BPM, else ReccoBeats tempo. */
  bpm: number | null;
  /** BPM with half-time (< 95) doubled, as the tracklist counts it. */
  effectiveBpm: number | null;
  inLibrary: boolean;
  previouslyDeleted: boolean;
}

async function deezer<T>(apiPath: string): Promise<T | null> {
  await sleep(DEEZER_GAP_MS);
  try {
    const res = await fetch(`https://api.deezer.com${apiPath}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const data = await res.json() as T & { error?: unknown };
    return data.error ? null : data;
  } catch {
    return null;
  }
}

interface ReccoRaw extends Partial<Record<keyof LookupFeatures, number>> { href?: string }

async function reccoByIsrc(isrc: string): Promise<{ uri: string | null; features: LookupFeatures } | null> {
  try {
    const res = await fetch(`https://api.reccobeats.com/v1/audio-features?ids=${encodeURIComponent(isrc)}`, {
      headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const first = (await res.json() as { content?: ReccoRaw[] }).content?.[0];
    if (!first) return null;
    const id = first.href?.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/)?.[1];
    const n = (v: number | undefined) => (typeof v === "number" ? v : null);
    return {
      uri: id ? `spotify:track:${id}` : null,
      features: {
        tempo: n(first.tempo), key: n(first.key), mode: n(first.mode), energy: n(first.energy),
        danceability: n(first.danceability), valence: n(first.valence), acousticness: n(first.acousticness),
        instrumentalness: n(first.instrumentalness), liveness: n(first.liveness), loudness: n(first.loudness),
        speechiness: n(first.speechiness),
      },
    };
  } catch {
    return null;
  }
}

interface DeezerTrackDetail {
  id: number;
  title: string;
  isrc?: string;
  link?: string;
  duration?: number;
  track_position?: number;
  disk_number?: number;
  rank?: number;
  release_date?: string;
  explicit_lyrics?: boolean;
  preview?: string;
  bpm?: number;
  gain?: number;
  contributors?: { name: string }[];
  artist: { name: string };
  album?: { id: number; title: string; cover_medium?: string };
}

export async function lookupTracks(artist: string, track: string): Promise<LookupResult[]> {
  const parts = [artist && `artist:"${artist}"`, track && `track:"${track}"`].filter(Boolean).join(" ");
  let search = await deezer<{ data?: { id: number }[] }>(`/search?q=${encodeURIComponent(parts)}&limit=${MAX_RESULTS}`);
  // The strict form misses some featured-artist titles — retry as free text.
  if (!search?.data?.length) {
    search = await deezer(`/search?q=${encodeURIComponent(`${artist} ${track}`.trim())}&limit=${MAX_RESULTS}`);
  }
  const ids = (search?.data ?? []).map(d => d.id).slice(0, MAX_RESULTS);

  const library = readAllTracks(loadRunningPlaylistConfig().csvFile);
  const libUris = new Set(library.map(t => t.uri).filter(Boolean));
  const libIsrcs = new Set(library.map(t => t.isrc).filter((x): x is string => !!x));
  type DeezerAlbum = { label?: string; record_type?: string; genres?: { data?: { name: string }[] } };
  const albums = new Map<number, DeezerAlbum | null>();

  const results: LookupResult[] = [];
  for (const id of ids) {
    const d = await deezer<DeezerTrackDetail>(`/track/${id}`);
    if (!d) continue;
    let album: DeezerAlbum | null | undefined = d.album ? albums.get(d.album.id) : null;
    if (d.album && album === undefined) {
      album = await deezer<DeezerAlbum>(`/album/${d.album.id}`);
      albums.set(d.album.id, album);
    }
    const recco = d.isrc ? await reccoByIsrc(d.isrc) : null;
    const bpm = d.bpm && d.bpm > 0 ? d.bpm : recco?.features.tempo ?? null;
    const uri = recco?.uri ?? null;
    results.push({
      deezerId: d.id,
      title: d.title,
      artist: d.artist.name,
      contributors: (d.contributors ?? []).map(c => c.name),
      album: d.album?.title ?? null,
      albumType: album?.record_type ?? null,
      label: album?.label ?? null,
      genres: (album?.genres?.data ?? []).map(g => g.name),
      releaseDate: d.release_date ?? null,
      trackPosition: d.track_position ?? null,
      discNumber: d.disk_number ?? null,
      durationSec: d.duration && d.duration > 0 ? d.duration : null,
      deezerBpm: d.bpm && d.bpm > 0 ? d.bpm : null,
      gain: typeof d.gain === "number" ? d.gain : null,
      explicit: !!d.explicit_lyrics,
      rank: d.rank ?? null,
      isrc: d.isrc ?? null,
      cover: d.album?.cover_medium ?? null,
      preview: d.preview || null,
      deezerUrl: d.link ?? null,
      spotifyUri: uri,
      features: recco?.features ?? null,
      bpm: bpm != null ? Math.round(bpm * 10) / 10 : null,
      effectiveBpm: bpm != null ? Math.round(bpm < 95 ? bpm * 2 : bpm) : null,
      inLibrary: (!!uri && libUris.has(uri)) || (!!d.isrc && libIsrcs.has(d.isrc)),
      previouslyDeleted: false,
    });
  }
  const deleted = findPreviouslyDeleted(results.map(r => r.spotifyUri).filter((u): u is string => !!u));
  for (const r of results) if (r.spotifyUri && deleted[r.spotifyUri]) r.previouslyDeleted = true;
  return results;
}

// Adds a looked-up track to the library and the Spotify playlist. An
// explicit add overrides a past deletion.
export async function addLookupTrack(r: LookupResult): Promise<{ addedToLibrary: boolean; addedToSpotify: boolean; error?: string }> {
  if (!r.spotifyUri) return { addedToLibrary: false, addedToSpotify: false, error: "No Spotify match for this track" };
  const f = r.features;
  const result = await addTracksToLibrary([{
    uri: r.spotifyUri, isrc: r.isrc ?? undefined, name: r.title, artist: r.artist,
    tempo: r.bpm ?? undefined,
    key: f?.key ?? undefined, mode: f?.mode ?? undefined, energy: f?.energy ?? undefined,
    danceability: f?.danceability ?? undefined, valence: f?.valence ?? undefined,
    ...(r.durationSec ? { durationMs: r.durationSec * 1000 } : {}),
    ...(r.genres.length ? { genres: r.genres.join(", ") } : {}),
  }], [r.spotifyUri]);
  const addedToLibrary = result.added > 0;
  if (addedToLibrary) void healActiveCsv().catch(() => {});

  // Spotify playlist: skip if the track is already on it.
  const config = loadRunningPlaylistConfig();
  const token = await getFreshToken();
  if (!token.ok) return { addedToLibrary, addedToSpotify: false, error: `Spotify token unavailable (${token.reason})` };
  const headers = { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" };
  let url: string | null = `https://api.spotify.com/v1/playlists/${config.id}/items?limit=100&fields=next,items(track(uri))`;
  while (url) {
    const res: Response = await fetch(url, { headers });
    if (!res.ok) break;
    const page = await res.json() as { next?: string | null; items?: { track?: { uri?: string } | null }[] };
    if ((page.items ?? []).some(i => i.track?.uri === r.spotifyUri)) return { addedToLibrary, addedToSpotify: false };
    url = page.next ?? null;
  }
  const res = await fetch(`https://api.spotify.com/v1/playlists/${config.id}/items`, {
    method: "POST", headers, body: JSON.stringify({ uris: [r.spotifyUri] }),
  });
  if (!res.ok) return { addedToLibrary, addedToSpotify: false, error: `Spotify add failed (${res.status})` };
  return { addedToLibrary, addedToSpotify: true };
}
