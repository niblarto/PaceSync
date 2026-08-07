import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { activeCsvPath, loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { updateTrackFeatures, regenerateCsvFile } from "@/lib/tracks-store";
import type { TrackRow } from "@/types/track";
import { healActiveCsv } from "@/lib/csv-heal";

// Manual single-field fix for a track flagged in Settings -> Tracklist ->
// "Tracks with errors" — the automatic heal sweep (Deezer/Spotify/Last.fm)
// couldn't find a value, so this lets a human type one in directly. Only
// the one field is written (updateTrackFeatures ignores keys not present in
// the patch), unlike /api/tracks/update-features which expects a full set.

const NUMBER_FIELDS = ["tempo", "key", "mode", "energy", "danceability", "valence", "durationMs"] as const;
const STRING_FIELDS = ["genres"] as const;
type EditableField = (typeof NUMBER_FIELDS)[number] | (typeof STRING_FIELDS)[number];

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { uri, field, value } = await req.json() as { uri?: string; field?: EditableField; value?: string };
  if (!uri?.trim()) return NextResponse.json({ error: "uri is required" }, { status: 400 });
  const isNumberField = !!field && (NUMBER_FIELDS as readonly string[]).includes(field);
  const isStringField = !!field && (STRING_FIELDS as readonly string[]).includes(field);
  if (!isNumberField && !isStringField) {
    return NextResponse.json({ error: "Unsupported field" }, { status: 400 });
  }
  if (value === undefined || value === null || value.trim() === "") {
    return NextResponse.json({ error: "value is required" }, { status: 400 });
  }

  const patch: Partial<TrackRow> = {};
  if (isNumberField) {
    const n = Number(value);
    if (!Number.isFinite(n)) return NextResponse.json({ error: "value must be a number" }, { status: 400 });
    (patch as Record<string, unknown>)[field!] = n;
  } else {
    (patch as Record<string, unknown>)[field!] = value.trim();
  }

  const csvFile = loadRunningPlaylistConfig().csvFile;
  try {
    updateTrackFeatures(csvFile, uri.trim(), patch);
    await regenerateCsvFile(csvFile, activeCsvPath());
    // Sweep for anything else still missing (e.g. other fields on this same
    // row) in the background, same as /api/tracks/update-features.
    void healActiveCsv().catch(e => console.warn("[tracks/update-field] heal failed:", e));
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
