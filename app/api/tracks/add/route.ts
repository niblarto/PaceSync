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
      // Backfill Duration (ms) and any missing features before responding,
      // so a mix built right after the add sees complete rows.
      const heal = await healActiveCsv().catch(() => null);
      return NextResponse.json({ ok: true, added, rejected, healed: heal?.healed ?? 0, incomplete: heal?.incomplete ?? 0 });
    }
    return NextResponse.json({ ok: true, added, rejected });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
