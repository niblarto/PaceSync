import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile } from "fs/promises";
import { listRunningPlaylists, csvPathFor } from "@/lib/running-playlist-config";

// Downloads a known playlist's raw library CSV — the same file shown as
// "csvFile" in the Select Playlist list, for inspecting/backing up outside
// the app (e.g. reconciling a track-count mismatch against Spotify).
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const entry = listRunningPlaylists().find(p => p.id === id);
  if (!entry) return NextResponse.json({ error: "Unknown playlist id" }, { status: 404 });

  try {
    const csv = await readFile(csvPathFor(entry), "utf8");
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${entry.csvFile}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "CSV file not found" }, { status: 404 });
  }
}
