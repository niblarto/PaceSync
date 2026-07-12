import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile } from "fs/promises";
import { listRunningPlaylists, loadRunningPlaylistConfig, setActiveRunningPlaylist, removeRunningPlaylist, csvPathFor } from "@/lib/running-playlist-config";

// Counts data rows in a playlist's CSV — same "is this a real row" rule as
// the write side (save-default-playlist): non-blank lines after the header.
async function trackCount(entry: { csvFile: string }): Promise<number | null> {
  try {
    const csv = await readFile(csvPathFor({ name: "", id: "", csvFile: entry.csvFile }), "utf8");
    const lines = csv.replace(/\r/g, "").split("\n").filter(l => l.trim());
    return Math.max(0, lines.length - 1); // minus header
  } catch {
    return null; // file missing — e.g. a freshly-registered playlist with no CSV yet
  }
}

// GET — every playlist this app has been pointed at, plus which is active
// and (for the Select Playlist list) each one's current track count.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const playlists = listRunningPlaylists();
  const active = loadRunningPlaylistConfig();
  const withCounts = await Promise.all(
    playlists.map(async p => ({ ...p, trackCount: await trackCount(p) }))
  );
  return NextResponse.json({ playlists: withCounts, activeId: active.id });
}

// PATCH { id } — switch the active playlist to an already-known id.
export async function PATCH(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await req.json() as { id?: string };
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const entry = setActiveRunningPlaylist(id);
  if (!entry) return NextResponse.json({ error: "Unknown playlist id" }, { status: 404 });
  return NextResponse.json(entry);
}

// DELETE { id, unfollowSpotify? } — drop local tracking + CSV file, and
// optionally unfollow the playlist on Spotify (there is no hard-delete API
// for a playlist owner; unfollowing removes it from the user's library).
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, unfollowSpotify } = await req.json() as { id?: string; unfollowSpotify?: boolean };
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  let spotifyError: string | null = null;
  if (unfollowSpotify) {
    const token = session.accessToken;
    if (!token) {
      spotifyError = "Not signed in to Spotify";
    } else {
      try {
        const res = await fetch(`https://api.spotify.com/v1/playlists/${id}/followers`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) spotifyError = `Spotify ${res.status}: ${await res.text()}`;
      } catch (e) {
        spotifyError = e instanceof Error ? e.message : String(e);
      }
    }
  }

  removeRunningPlaylist(id);
  const active = loadRunningPlaylistConfig();
  return NextResponse.json({ ok: true, spotifyError, active });
}
