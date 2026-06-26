import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getPlaylistTracks, getAudioFeatures } from "@/lib/spotify";
import type { TrackWithBPM } from "@/types";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const playlistId = req.nextUrl.searchParams.get("playlistId");
  if (!playlistId) {
    return NextResponse.json({ error: "playlistId required" }, { status: 400 });
  }

  try {
    const tokenPreview = session.accessToken?.slice(0, 20) ?? "none";
    console.log(`[tracks] playlistId=${playlistId} token=${tokenPreview}...`);
    const tracks = await getPlaylistTracks(session.accessToken, playlistId);
    console.log(`[tracks] playlistId=${playlistId} trackCount=${tracks.length}`);

    const ids = tracks.map((t) => t.id);

    let features: Awaited<ReturnType<typeof getAudioFeatures>> = [];
    try {
      features = await getAudioFeatures(session.accessToken, ids);
      console.log(`[tracks] audioFeatures ok, count=${features.length}`);
    } catch (featErr) {
      const msg = featErr instanceof Error ? featErr.message : String(featErr);
      console.error(`[tracks] audioFeatures failed: ${msg}`);
      return NextResponse.json(
        { error: `Audio features unavailable: ${msg}. The Spotify audio-features API was deprecated in Nov 2024 for new apps — see https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api` },
        { status: 503 }
      );
    }

    const featuresMap = new Map(features.map((f) => [f.id, f]));

    const tracksWithBPM: TrackWithBPM[] = tracks
      .map((track) => {
        const feat = featuresMap.get(track.id);
        if (!feat) return null;
        return {
          ...track,
          bpm: Math.round(feat.tempo),
          energy: feat.energy,
        };
      })
      .filter((t): t is TrackWithBPM => t !== null);

    return NextResponse.json({ tracks: tracksWithBPM });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[tracks] error: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
