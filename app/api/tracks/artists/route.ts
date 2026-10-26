import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { readAllTracks } from "@/lib/tracks-store";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";

// The library's distinct single artist names (credits like "Blur;Adrian Sherwood" split
// into their own names), for the Song Crawler's Artist autofill.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const names = new Set<string>();
  for (const t of readAllTracks(loadRunningPlaylistConfig().csvFile)) {
    for (const a of (t.artistNames ?? "").split(/[;,]/)) {
      const name = a.trim();
      if (name) names.add(name);
    }
  }
  return NextResponse.json({ artists: Array.from(names).sort((a, b) => a.localeCompare(b)) });
}
