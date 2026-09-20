import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { healActiveCsv } from "@/lib/csv-heal";
import { addTracksToLibrary, type LibraryAddTrack } from "@/lib/library-add";

// Appends accepted song suggestions to public/Running.csv so they join the
// local BPM pool. Spotify playlist addition happens client-side with the
// browser token (same pattern as delete). After the write, the CSV heal
// sweep backfills anything the caller didn't supply (Duration (ms), audio
// features) so the AI DJ mixer never sees blank rows.
//
// Previously-deleted tracks are rejected (returned in `rejected`) unless
// their URIs are passed in allowDeletedUris — the review UI's override
// checkboxes. Overridden tracks are removed from the deletion log.

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { tracks, allowDeletedUris } = await req.json() as { tracks?: LibraryAddTrack[]; allowDeletedUris?: string[] };
  if (!tracks?.length) return NextResponse.json({ error: "No tracks" }, { status: 400 });

  try {
    const { added, rejected } = await addTracksToLibrary(tracks, allowDeletedUris);
    if (added > 0) {
      // Backfill Duration (ms) and any missing features — fired but not
      // awaited: a heal sweep does a Spotify/ReccoBeats/Deezer lookup PER
      // missing track, which for a large batch (e.g. Settings' "Sync from
      // Spotify" pulling in many tracks at once) can run well past a
      // minute — long enough to trip the tunnel/proxy in front of this app
      // and return an HTML timeout page instead of this route's own JSON,
      // which the client then failed to parse ("Unexpected token '<'").
      // healActiveCsv() already tracks its own progress (lib/csv-heal.ts's
      // writeProgress), which Settings' "Check missing" bar polls via
      // /api/settings/heal-status — every caller of this route already
      // refreshes that same status after a successful add, so nothing here
      // needs to wait for the sweep to actually finish.
      void healActiveCsv().catch(() => {});
      return NextResponse.json({ ok: true, added, rejected });
    }
    return NextResponse.json({ ok: true, added, rejected });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
