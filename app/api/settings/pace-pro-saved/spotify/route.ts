import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSpotifyUser } from "@/lib/spotify";
import { upsertPlaylist } from "@/lib/spotify-playlist";
import { getSavedPaceProMix, setSavedPaceProMixPlaylist } from "@/lib/pace-pro-saved";

// Saves a saved Pace Pro mix's tracks to ITS OWN Spotify playlist — named
// after the mix's own title (find-or-create), unlike the ad-hoc Pace Pro
// builder's "Save to Spotify" button which always targets the single
// shared "Today's Run" playlist. This is what gives a saved mix a distinct
// playlist that "Duplicate" + "Rename" (rename route) can operate on
// per-mix, instead of every saved mix colliding on one shared playlist.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await req.json() as { id?: string };
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const mix = getSavedPaceProMix(id);
  if (!mix) return NextResponse.json({ error: "Saved mix not found" }, { status: 404 });
  const trackUris = mix.timeline.flatMap(s => s.tracks.map(t => t.uri)).filter(Boolean);
  if (!trackUris.length) return NextResponse.json({ error: "This mix has no tracks" }, { status: 400 });

  try {
    const user = await getSpotifyUser(session.accessToken);
    const result = await upsertPlaylist(
      session.accessToken,
      user.id,
      mix.title,
      `Pace Pro mix (${mix.title}) from Settings → Pace Pro`,
      trackUris,
    );
    if (result.playlistId !== mix.spotifyPlaylistId) {
      setSavedPaceProMixPlaylist(id, result.playlistId);
    }
    return NextResponse.json({ ...result, spotifyPlaylistId: result.playlistId });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to save to Spotify" }, { status: 500 });
  }
}
