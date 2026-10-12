import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSpotifyUser } from "@/lib/spotify";
import { upsertPlaylist } from "@/lib/spotify-playlist";
import { hasApiAccess } from "@/lib/mobile-auth";
import { getFreshToken } from "@/lib/tokenStore";

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Browser sessions carry their own Spotify token; the Android app has
  // none, so fall back to the server's stored one.
  const session = await getServerSession(authOptions);
  let token = session?.accessToken;
  if (!token) {
    const stored = await getFreshToken();
    if (!stored.ok) return NextResponse.json({ error: `No Spotify token available (${stored.reason})` }, { status: 502 });
    token = stored.token;
  }

  const { name, description, trackUris } = await req.json() as {
    name: string;
    description: string;
    trackUris: string[];
  };

  if (!name || !trackUris?.length) {
    return NextResponse.json({ error: "name and trackUris required" }, { status: 400 });
  }

  try {
    const user = await getSpotifyUser(token);
    console.log(`[create-playlist] userId=${user.id} name="${name}" tracks=${trackUris.length}`);

    const result = await upsertPlaylist(token, user.id, name, description ?? "", trackUris);
    if (result.replaced) {
      console.log(`[create-playlist] found existing playlist ${result.playlistId} — replaced tracks`);
    } else {
      console.log(`[create-playlist] created ${result.playlistId}`);
    }
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[create-playlist] error: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
