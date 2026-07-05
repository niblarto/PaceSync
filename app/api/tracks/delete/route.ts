import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile, writeFile } from "fs/promises";
import { activeCsvPath } from "@/lib/running-playlist-config";

// CSV-only deletion — Spotify removal is handled client-side with the browser token
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { spotifyUri } = await req.json() as { spotifyUri: string };
  if (!spotifyUri) return NextResponse.json({ error: "Missing spotifyUri" }, { status: 400 });

  const trackId = spotifyUri.startsWith("spotify:track:")
    ? spotifyUri.slice("spotify:track:".length)
    : spotifyUri;

  const csvPath = activeCsvPath();
  try {
    const csv = await readFile(csvPath, "utf8");
    const lines = csv.split("\n");
    const before = lines.length;
    const filtered = lines.filter((line, i) => {
      if (i === 0) return true;
      return !line.includes(trackId);
    });
    if (filtered.length < before) {
      await writeFile(csvPath, filtered.join("\n"), "utf8");
      return NextResponse.json({ ok: true, csvRemoved: true });
    }
    return NextResponse.json({ ok: true, csvRemoved: false });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
