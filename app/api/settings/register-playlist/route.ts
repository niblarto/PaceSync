import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { csvPathFor, loadRunningPlaylistConfig, saveRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { readTracksByUris, appendTracks, regenerateCsvFile } from "@/lib/tracks-store";
import { healActiveCsv } from "@/lib/csv-heal";

// Registers a Spotify playlist (already created client-side) as a known
// local playlist with its own CSV, without switching the currently-active
// playlist, then seeds that CSV with the given tracks' rows copied straight
// from the active library (same source-of-truth pattern as
// tracks/copy-to-playlist) — used by "copy to a new playlist" actions (e.g.
// Library Coverage) so the target doesn't need to re-look up BPM/features.

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name, id, uris } = await req.json() as { name?: string; id?: string; uris?: string[] };
  if (!name || !id) return NextResponse.json({ error: "name and id required" }, { status: 400 });
  if (!uris?.length) return NextResponse.json({ error: "No tracks to copy" }, { status: 400 });

  const activeCsvFile = loadRunningPlaylistConfig().csvFile;
  const matchedRows = readTracksByUris(activeCsvFile, uris);
  if (matchedRows.length === 0) return NextResponse.json({ error: "None of the requested tracks were found in the active library" }, { status: 404 });

  const entry = saveRunningPlaylistConfig({ name, id }, { keepCurrentActive: true });
  const appended = appendTracks(entry.csvFile, matchedRows);
  await regenerateCsvFile(entry.csvFile, csvPathFor(entry));
  void healActiveCsv().catch(() => {}); // no-op unless this happens to be the active playlist

  return NextResponse.json({ ok: true, entry, appended, merged: 0, skipped: 0 });
}
