import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readAllTracks, updateTrackFeatures, regenerateCsvFile } from "@/lib/tracks-store";
import { activeCsvPath, loadRunningPlaylistConfig } from "@/lib/running-playlist-config";

// Settings -> Tracklist -> "Genre explorer": moves tracks tagged with
// `from` onto `to` instead — e.g. an unmapped/miscategorized tag like
// "other drum-and-bass" gets folded into the real "drum and bass" tag. Each
// track's Genres cell is a COMMA-SEPARATED list (lib/tracks-store.ts), so
// this replaces only the ONE matching tag within that string, preserving
// every other genre tag the track already carries — never a wholesale
// overwrite the way /api/tracks/update-field's single-field edit is. A
// track that (for whatever reason) already carries `to` as well as `from`
// just has `from` dropped, rather than ending up with `to` listed twice.
//
// uri (optional): restricts the move to just that one track — the
// explorer's per-track "Move…" action, for reassigning a single
// mis-tagged song without touching every other track sharing that genre.
// Omitted (the default) moves EVERY track currently tagged `from`.
function parseGenres(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(",").map(g => g.trim()).filter(Boolean);
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { from, to, uri } = await req.json() as { from?: string; to?: string; uri?: string };
  const fromTag = from?.trim().toLowerCase();
  const toTag = to?.trim().toLowerCase();
  if (!fromTag || !toTag) return NextResponse.json({ error: "from and to are required" }, { status: 400 });
  if (fromTag === toTag) return NextResponse.json({ error: "from and to must be different" }, { status: 400 });

  const csvFile = loadRunningPlaylistConfig().csvFile;
  try {
    const rows = readAllTracks(csvFile);
    let moved = 0;
    for (const row of rows) {
      if (!row.uri) continue;
      if (uri && row.uri !== uri) continue;
      const tags = parseGenres(row.genres);
      const idx = tags.findIndex(t => t.toLowerCase() === fromTag);
      if (idx === -1) continue;
      const withoutFrom = tags.filter((t, i) => i !== idx);
      const alreadyHasTo = withoutFrom.some(t => t.toLowerCase() === toTag);
      const nextTags = alreadyHasTo ? withoutFrom : [...withoutFrom, to!.trim()];
      updateTrackFeatures(csvFile, row.uri, { genres: nextTags.join(", ") });
      moved++;
    }
    if (moved === 0) {
      const scope = uri ? "This track isn't" : `No tracks are`;
      return NextResponse.json({ error: `${scope} tagged "${from}"` }, { status: 404 });
    }
    await regenerateCsvFile(csvFile, activeCsvPath());
    // NOT triggering healActiveCsv() here, unlike update-field's single-
    // field edit — a move always leaves every affected track with at
    // least one real genre tag (the `to` tag), so there's no gap for heal
    // to legitimately fill. Running it anyway (background, unawaited) was
    // a live-confirmed source of a confusing race: heal's own genre-gap
    // sweep can still be mid-flight from an earlier move when the NEXT
    // move's client-side refresh fetches /api/tracks/genres, and if heal's
    // write landed in between, a tag the user just explicitly moved away
    // from ("Other") could silently reappear moments later with no further
    // action from the user — exactly the reported "count shows 1, no
    // tracks, only fixed by a full page reload" symptom, since a reload's
    // fresh fetch would just catch whatever heal had settled on by then.
    return NextResponse.json({ ok: true, moved });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to move genre" }, { status: 500 });
  }
}
