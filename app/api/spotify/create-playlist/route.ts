import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSpotifyUser } from "@/lib/spotify";
import { upsertPlaylist } from "@/lib/spotify-playlist";

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
