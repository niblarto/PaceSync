import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSavedPaceProMix, renameSavedPaceProMix } from "@/lib/pace-pro-saved";
import { clearCachedPlaylistId, setCachedPlaylistId } from "@/lib/playlist-id-cache";

// Renames a saved Pace Pro mix — locally, and on Spotify too if this mix
// already has its own linked playlist (spotifyPlaylistId, set the first
// time "Save to Spotify" ran for it — see the pace-pro-saved/spotify
// route). A mix that was never saved to Spotify yet has nothing to rename
// there; its playlist just gets created under the new title whenever it
// first is saved.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, title } = await req.json() as { id?: string; title?: string };
  if (!id || !title?.trim()) return NextResponse.json({ error: "id and title required" }, { status: 400 });

  const mix = getSavedPaceProMix(id);
  if (!mix) return NextResponse.json({ error: "Saved mix not found" }, { status: 404 });

  const newTitle = title.trim();
  const oldTitle = mix.title;
  const applied = renameSavedPaceProMix(id, newTitle);
  if (!applied) return NextResponse.json({ error: "Rename failed" }, { status: 500 });

  let spotifyRenamed = false;
  let spotifyError: string | undefined;
  if (mix.spotifyPlaylistId && session.accessToken) {
    try {
      const res = await fetch(`https://api.spotify.com/v1/playlists/${mix.spotifyPlaylistId}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: newTitle }),
      });
      if (!res.ok) throw new Error(`Spotify rename failed (${res.status})`);
      spotifyRenamed = true;
      // The playlist-id cache is keyed by playlist NAME (see
      // lib/playlist-id-cache.ts) — the old name's entry would otherwise
      // keep pointing at this id under a name the playlist no longer has.
      // Re-point the new name at it too, so the next "Save to Spotify" for
      // this mix (an upsertPlaylist lookup by the mix's current title)
      // hits this id directly instead of a full library rescan.
      clearCachedPlaylistId(oldTitle);
      setCachedPlaylistId(newTitle, mix.spotifyPlaylistId);
    } catch (e) {
      spotifyError = e instanceof Error ? e.message : "Failed to rename Spotify playlist";
    }
  }

  return NextResponse.json({ ok: true, title: newTitle, spotifyRenamed, spotifyError });
}
