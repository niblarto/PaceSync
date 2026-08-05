import { getCachedPlaylistId, setCachedPlaylistId, clearCachedPlaylistId } from "@/lib/playlist-id-cache";

const BASE = "https://api.spotify.com/v1";

// Full GET /me/playlists scan (paginated) — the actual Spotify-calling
// implementation, kept separate from findExistingPlaylist's cache check
// below so a stale cache hit can fall back to this without duplicating it.
async function scanForPlaylist(token: string, userId: string, name: string): Promise<string | null> {
  let url: string | null = `${BASE}/me/playlists?limit=50`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) break;
    const data = await res.json() as {
      items: { id: string; name: string; owner: { id: string } }[];
      next: string | null;
    };
    const match = data.items.find(
      p => p.name.toLowerCase() === name.toLowerCase() && p.owner.id === userId
    );
    if (match) return match.id;
    url = data.next;
  }
  return null;
}

// Checks a persisted id-cache before ever scanning the user's whole
// playlist library — the standing "Today's Run" playlist this backs almost
// never changes id, but the two daily AI DJ cron jobs call this
// unconditionally every run, so an uncached lookup here is guaranteed
// wasted Spotify quota on every no-op day. A cache hit is verified with a
// single GET /playlists/{id} (cheap, one request) rather than trusted
// blindly, so a deleted/renamed playlist is detected and the cache
// self-heals via a fresh scan instead of upsertPlaylist silently creating
// a duplicate playlist against a dead id.
export async function findExistingPlaylist(token: string, userId: string, name: string): Promise<string | null> {
  const cached = getCachedPlaylistId(name);
  if (cached) {
    try {
      const res = await fetch(`${BASE}/playlists/${cached}?fields=id,name,owner.id`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const p = await res.json() as { id: string; name: string; owner: { id: string } };
        if (p.name.toLowerCase() === name.toLowerCase() && p.owner.id === userId) return cached;
      }
    } catch { /* fall through to a fresh scan */ }
    clearCachedPlaylistId(name);
  }

  const found = await scanForPlaylist(token, userId, name);
  if (found) setCachedPlaylistId(name, found);
  return found;
}

export async function replacePlaylistTracks(token: string, playlistId: string, uris: string[]): Promise<void> {
  // PUT replaces all existing tracks with the first batch (max 100)
  const putRes = await fetch(`${BASE}/playlists/${playlistId}/items`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ uris: uris.slice(0, 100) }),
  });
  if (!putRes.ok) throw new Error(`Replace tracks ${putRes.status}: ${await putRes.text()}`);

  for (let i = 100; i < uris.length; i += 100) {
    await new Promise(r => setTimeout(r, 150));
    const res = await fetch(`${BASE}/playlists/${playlistId}/items`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: uris.slice(i, i + 100) }),
    });
    if (!res.ok) throw new Error(`Add tracks ${res.status}: ${await res.text()}`);
  }
}

export interface UpsertResult {
  playlistId: string;
  url: string;
  tracksAdded: boolean;
  replaced: boolean;
  trackUris?: string[];
}

// Find-or-create a playlist by name (owned by userId) and replace its tracks.
export async function upsertPlaylist(
  token: string,
  userId: string,
  name: string,
  description: string,
  trackUris: string[],
): Promise<UpsertResult> {
  const existingId = await findExistingPlaylist(token, userId, name);

  if (existingId) {
    const playlistUrl = `https://open.spotify.com/playlist/${existingId}`;
    // Keep the description in step with what the playlist now holds (e.g.
    // which workout "Today's Run" is for) — best-effort, never fails the save.
    if (description) {
      try {
        await fetch(`${BASE}/playlists/${existingId}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ description }),
        });
      } catch { /* description update is cosmetic */ }
    }
    try {
      await replacePlaylistTracks(token, existingId, trackUris);
      return { playlistId: existingId, url: playlistUrl, tracksAdded: true, replaced: true };
    } catch {
      return { playlistId: existingId, url: playlistUrl, tracksAdded: false, replaced: true, trackUris };
    }
  }

  const res = await fetch(`${BASE}/me/playlists`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, description, public: true }),
  });
  if (!res.ok) throw new Error(`Create playlist ${res.status}: ${await res.text()}`);
  const playlist = await res.json() as { id: string; external_urls: { spotify: string } };

  try {
    await replacePlaylistTracks(token, playlist.id, trackUris);
    return { playlistId: playlist.id, url: playlist.external_urls.spotify, tracksAdded: true, replaced: false };
  } catch {
    return { playlistId: playlist.id, url: playlist.external_urls.spotify, tracksAdded: false, replaced: false, trackUris };
  }
}
