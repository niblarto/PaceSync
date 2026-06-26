import type { SpotifyPlaylist, SpotifyTrack, AudioFeatures } from "@/types";

const BASE = "https://api.spotify.com/v1";

async function spotifyFetch(path: string, token: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Spotify ${path}: ${res.status} ${err}`);
  }
  return res.json();
}

export async function getSpotifyUser(token: string) {
  return spotifyFetch("/me", token);
}

export async function getPlaylists(token: string): Promise<SpotifyPlaylist[]> {
  const playlists: SpotifyPlaylist[] = [];
  let url: string | null = `${BASE}/me/playlists?limit=50`;

  while (url) {
    const currentUrl = url;
    const res: Response = await fetch(currentUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error("Failed to fetch playlists");
    const data = await res.json() as { items: SpotifyPlaylist[]; next: string | null };
    playlists.push(...data.items);
    url = data.next;
  }
  return playlists;
}

export async function getPlaylistTracks(
  token: string,
  playlistId: string
): Promise<SpotifyTrack[]> {
  // First try GET /playlists/{id} which embeds tracks and may have looser access than /tracks
  const playlistRes = await fetch(`${BASE}/playlists/${playlistId}?market=from_token`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (playlistRes.ok) {
    const playlist = await playlistRes.json() as {
      tracks?: { items?: { track: SpotifyTrack | null }[]; next?: string | null; href?: string; total?: number };
      items?: { track: SpotifyTrack | null }[];
      next?: string | null;
    };

    console.log(`[spotify] playlist object keys: ${Object.keys(playlist).join(", ")}`);

    const tracks: SpotifyTrack[] = [];
    // Spotify now returns items at the top level rather than nested under tracks
    const items = playlist.tracks?.items ?? playlist.items;

    if (items && items.length > 0) {
      const valid = items
        .map((i) => i.track)
        .filter((t): t is SpotifyTrack => t !== null && !!t.id);
      tracks.push(...valid);

      let next = playlist.tracks?.next ?? playlist.next ?? null;
      while (next) {
        const currentUrl = next;
        const res: Response = await fetch(currentUrl, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) break;
        const data = await res.json() as { items: { track: SpotifyTrack | null }[]; next: string | null };
        const more = (data.items ?? [])
          .map((i) => i.track)
          .filter((t): t is SpotifyTrack => t !== null && !!t.id);
        tracks.push(...more);
        next = data.next;
      }
      return tracks;
    }

    // Playlist object returned but no items embedded — try the tracks href directly
    const tracksHref = playlist.tracks?.href;
    if (tracksHref) {
      console.log(`[spotify] falling back to tracks href: ${tracksHref.slice(0, 80)}`);
      const res: Response = await fetch(`${tracksHref}?limit=100`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json() as { items: { track: SpotifyTrack | null }[]; next: string | null };
        const valid = (data.items ?? [])
          .map((i) => i.track)
          .filter((t): t is SpotifyTrack => t !== null && !!t.id);
        tracks.push(...valid);
        return tracks;
      }
      const errBody = await res.text();
      throw new Error(`Tracks href fetch failed: HTTP ${res.status} — ${errBody}`);
    }

    throw new Error(`No tracks found in playlist response. Keys: ${Object.keys(playlist).join(", ")}. tracks field: ${JSON.stringify(playlist.tracks)}`);
  }

  const body = await playlistRes.text();
  throw new Error(`Playlist fetch failed: HTTP ${playlistRes.status} — ${body}`);
}

export async function getAudioFeatures(
  token: string,
  trackIds: string[]
): Promise<AudioFeatures[]> {
  const all: AudioFeatures[] = [];

  for (let i = 0; i < trackIds.length; i += 100) {
    const batch = trackIds.slice(i, i + 100);
    const data = await spotifyFetch(
      `/audio-features?ids=${batch.join(",")}`,
      token
    );
    const features = (data.audio_features as (AudioFeatures | null)[]).filter(
      (f): f is AudioFeatures => f !== null
    );
    all.push(...features);
  }
  return all;
}

export async function createPlaylist(
  token: string,
  userId: string,
  name: string,
  description: string
): Promise<{ id: string; external_urls: { spotify: string } }> {
  // /me/playlists works for new apps; /users/{id}/playlists returns 403
  return spotifyFetch(`/me/playlists`, token, {
    method: "POST",
    body: JSON.stringify({ name, description, public: true }),
  });
}

export async function addTracksToPlaylist(
  token: string,
  playlistId: string,
  uris: string[]
): Promise<void> {
  for (let i = 0; i < uris.length; i += 100) {
    await spotifyFetch(`/playlists/${playlistId}/items`, token, {
      method: "POST",
      body: JSON.stringify({ uris: uris.slice(i, i + 100) }),
    });
  }
}
