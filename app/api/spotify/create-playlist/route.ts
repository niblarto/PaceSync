import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSpotifyUser, createPlaylist } from "@/lib/spotify";

const BASE = "https://api.spotify.com/v1";

async function findExistingPlaylist(token: string, userId: string, name: string): Promise<string | null> {
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

async function replacePlaylistTracks(token: string, playlistId: string, uris: string[]): Promise<void> {
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

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { name, description, trackUris } = await req.json() as {
    name: string;
    description: string;
    trackUris: string[];
  };

  if (!name || !trackUris?.length) {
    return NextResponse.json({ error: "name and trackUris required" }, { status: 400 });
  }

  const token = session.accessToken;

  try {
    const user = await getSpotifyUser(token);
    console.log(`[create-playlist] userId=${user.id} name="${name}" tracks=${trackUris.length}`);

    // Check for existing playlist with the same name owned by this user
    const existingId = await findExistingPlaylist(token, user.id, name);

    if (existingId) {
      console.log(`[create-playlist] found existing playlist ${existingId} — replacing tracks`);
      const playlistUrl = `https://open.spotify.com/playlist/${existingId}`;
      try {
        await replacePlaylistTracks(token, existingId, trackUris);
        return NextResponse.json({ playlistId: existingId, url: playlistUrl, tracksAdded: true, replaced: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[create-playlist] replacePlaylistTracks failed: ${msg}`);
        return NextResponse.json({ playlistId: existingId, url: playlistUrl, tracksAdded: false, trackUris, replaced: true });
      }
    }

    // No existing playlist — create a new one
    const playlist = await createPlaylist(token, user.id, name, description ?? "");
    console.log(`[create-playlist] created ${playlist.id}`);

    try {
      await replacePlaylistTracks(token, playlist.id, trackUris);
      return NextResponse.json({ playlistId: playlist.id, url: playlist.external_urls.spotify, tracksAdded: true });
    } catch (trackErr) {
      const msg = trackErr instanceof Error ? trackErr.message : String(trackErr);
      console.error(`[create-playlist] addTracks failed: ${msg}`);
      return NextResponse.json({
        playlistId: playlist.id,
        url: playlist.external_urls.spotify,
        tracksAdded: false,
        trackUris,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[create-playlist] error: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
