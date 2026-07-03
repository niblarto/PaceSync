const BASE = "https://api.spotify.com/v1";

export async function findExistingPlaylist(token: string, userId: string, name: string): Promise<string | null> {
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

export async function replacePlaylistTracks(token: string, playlistId: string, uris: string[]): Promise<void> {
  // PUT replaces all existing tracks with the first batch (max 100)
  const putRes = await fetch(`${BASE}/playlists/${playlistId}/items`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ uris: uris.slice(0, 100) }),
  });
  if (!putRes.ok) throw new Error(`Replace tracks ${putRes.status}: ${await putRes.text()}`);

  for (let i = 100; i < uris.length; i += 100) {
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
