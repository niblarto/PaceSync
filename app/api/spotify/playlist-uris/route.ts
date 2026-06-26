import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const playlistId = req.nextUrl.searchParams.get("id");
  if (!playlistId) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const token = session.accessToken;
  const uris: string[] = [];
  // GET /playlists/{id}/items is the current Spotify endpoint (tracks is deprecated)
  let url: string | null =
    `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100`;

  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const rawText = await res.text();
    console.log(`[playlist-uris] status=${res.status} url=${url.slice(0, 80)} body=${rawText.slice(0, 300)}`);
    if (!res.ok) {
      return NextResponse.json(
        { error: `Spotify ${res.status}: ${rawText}` },
        { status: res.status }
      );
    }
    const data = JSON.parse(rawText) as {
      items?: { track?: { uri?: string } }[];
      next?: string | null;
      total?: number;
    };
    console.log(`[playlist-uris] total=${data.total} items=${data.items?.length ?? 0} next=${data.next ? "yes" : "no"}`);
    if (uris.length === 0 && (data.items?.length ?? 0) > 0) {
      console.log(`[playlist-uris] first-item: ${JSON.stringify(data.items![0]).slice(0, 500)}`);
    }
    for (const item of data.items ?? []) {
      if (item.track?.uri) uris.push(item.track.uri);
    }
    url = data.next ?? null;
  }

  console.log(`[playlist-uris] ${playlistId}: ${uris.length} uris`);
  return NextResponse.json({ uris, total: uris.length });
}
