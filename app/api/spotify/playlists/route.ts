import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getPlaylists } from "@/lib/spotify";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const playlists = await getPlaylists(session.accessToken);
    console.log(`[playlists] user=${session.user?.id} count=${playlists.length} withTracks=${playlists.filter((p) => p?.tracks).length}`);
    return NextResponse.json({ playlists, debug: { total: playlists.length } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
