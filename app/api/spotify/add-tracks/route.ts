import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { addTracksToPlaylist } from "@/lib/spotify";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { playlistId, trackUris } = await req.json() as {
    playlistId: string;
    trackUris: string[];
  };

  if (!playlistId || !trackUris?.length) {
    return NextResponse.json({ error: "playlistId and trackUris required" }, { status: 400 });
  }

  console.log(`[add-tracks] playlistId=${playlistId} count=${trackUris.length}`);

  try {
    await addTracksToPlaylist(session.accessToken, playlistId, trackUris);
    return NextResponse.json({
      url: `https://open.spotify.com/playlist/${playlistId}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[add-tracks] error: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
