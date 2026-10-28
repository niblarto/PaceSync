import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requestPlaylistSave } from "@/lib/spotify-outbox";
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
    // The mix itself is already saved (the Pace Pro library). The Spotify playlist is sent now, or
    // queued if Spotify is rate-limiting and created when that clears (the queue then records its id).
    const out = await requestPlaylistSave(session.accessToken, {
      name: mix.title,
      description: `Pace Pro mix (${mix.title}) from Settings → Pace Pro`,
      uris: trackUris,
      after: { kind: "paceProMix", id },
    });
    if (out.status === "queued") {
      return NextResponse.json({
        queued: true, until: out.until,
        message: `The mix is saved in PaceSync. Spotify is rate-limiting, so its playlist will be created automatically${out.until ? ` after about ${new Date(out.until).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : " when Spotify allows"}.`,
      });
    }
    const result = out.result;
    if (result.playlistId !== mix.spotifyPlaylistId) {
      setSavedPaceProMixPlaylist(id, result.playlistId);
    }
    return NextResponse.json({ ...result, spotifyPlaylistId: result.playlistId });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to save to Spotify" }, { status: 500 });
  }
}
