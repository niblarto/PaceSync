import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSpotifyUser } from "@/lib/spotify";
import { findExistingPlaylist } from "@/lib/spotify-playlist";
import { loadRunningPlaylistConfig, saveRunningPlaylistConfig } from "@/lib/running-playlist-config";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(loadRunningPlaylistConfig());
}

// POST { name } — resolve the playlist by name in the user's library
// (creating it when missing) and make it the default.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await req.json() as { name?: string };
  const trimmed = name?.trim();
  if (!trimmed) return NextResponse.json({ error: "name required" }, { status: 400 });

  const token = session.accessToken;
  try {
    const user = await getSpotifyUser(token);
    let id = await findExistingPlaylist(token, user.id, trimmed);
    let created = false;
    if (!id) {
      const res = await fetch("https://api.spotify.com/v1/me/playlists", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, description: "PaceSync library playlist", public: true }),
      });
      if (!res.ok) throw new Error(`Create playlist ${res.status}: ${await res.text()}`);
      id = ((await res.json()) as { id: string }).id;
      created = true;
    }
    saveRunningPlaylistConfig({ name: trimmed, id });
    return NextResponse.json({ name: trimmed, id, created });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
