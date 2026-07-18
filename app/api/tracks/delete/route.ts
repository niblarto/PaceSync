import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile, writeFile } from "fs/promises";
import { activeCsvPath } from "@/lib/running-playlist-config";

// CSV-only deletion — Spotify removal is handled client-side with the browser token.
// Accepts either a single spotifyUri (back-compat) or a spotifyUris batch, doing one
// CSV read/write for the whole batch instead of a round-trip per track.
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { spotifyUri, spotifyUris } = await req.json() as { spotifyUri?: string; spotifyUris?: string[] };
  const uris = spotifyUris?.length ? spotifyUris : (spotifyUri ? [spotifyUri] : []);
  if (uris.length === 0) return NextResponse.json({ error: "Missing spotifyUri(s)" }, { status: 400 });

  const trackIds = Array.from(new Set(uris.map(u => u.startsWith("spotify:track:") ? u.slice("spotify:track:".length) : u)));

  const csvPath = activeCsvPath();
  try {
    const csv = await readFile(csvPath, "utf8");
    const lines = csv.split("\n");
    const before = lines.length;
    const filtered = lines.filter((line, i) => {
      if (i === 0) return true;
      return !trackIds.some(id => line.includes(id));
    });
    if (filtered.length < before) {
      await writeFile(csvPath, filtered.join("\n"), "utf8");
      return NextResponse.json({ ok: true, csvRemoved: true, removed: before - filtered.length });
    }
    return NextResponse.json({ ok: true, csvRemoved: false, removed: 0 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
