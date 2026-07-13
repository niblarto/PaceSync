import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile } from "fs/promises";
import { activeCsvPath } from "@/lib/running-playlist-config";

// Lightweight URI-only listing of the active playlist's CSV — used to dedupe
// before adding tracks (e.g. from BBC), so the same track never gets added
// twice to either Spotify or the local library.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const csv = await readFile(activeCsvPath(), "utf8");
    const uris = new Set<string>();
    csv.split("\n").forEach(line => {
      const uri = line.split(",")[0]?.trim();
      if (uri?.startsWith("spotify:track:")) uris.add(uri);
    });
    return NextResponse.json({ uris: Array.from(uris) });
  } catch {
    return NextResponse.json({ uris: [] });
  }
}
