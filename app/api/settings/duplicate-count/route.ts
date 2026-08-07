import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { readAllTracks } from "@/lib/tracks-store";

// Lightweight count-only counterpart to SettingsClient's duplicateGroups —
// same near-duplicate grouping (same song under two-plus different Spotify
// track IDs, e.g. an original single vs. a "- Remastered 2011" reissue),
// computed server-side against the DB directly so the dashboard's duplicate
// banner doesn't need to pull the whole library CSV into the browser just
// to show a count. Keep dupMatchKey here in sync with SettingsClient.tsx's
// copy if that matching logic ever changes.

function dupMatchKey(name: string, artist: string): string {
  const clean = (s: string) => s
    .toLowerCase()
    .replace(/\s*[([-].*$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return `${clean(artist)}|||${clean(name)}`;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const rows = readAllTracks(loadRunningPlaylistConfig().csvFile);
    const byKey = new Map<string, number>();
    for (const row of rows) {
      const name = row.trackName?.trim() || "Unknown";
      const artist = row.artistNames?.trim() || "Unknown";
      const key = dupMatchKey(name, artist);
      byKey.set(key, (byKey.get(key) ?? 0) + 1);
    }
    const count = Array.from(byKey.values()).filter(n => n > 1).length;
    return NextResponse.json({ count });
  } catch {
    return NextResponse.json({ count: 0 });
  }
}
