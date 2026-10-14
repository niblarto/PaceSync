import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { addLookupTrack, lookupTracks, type LookupResult } from "@/lib/track-lookup";

// Track Lookup (Settings > Tracklist):
//   GET  ?artist=&track=   -> Deezer + ReccoBeats data for each match (nothing saved)
//   POST { add: LookupResult } -> add that track to the library + Spotify playlist
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const artist = (req.nextUrl.searchParams.get("artist") ?? "").trim();
  const track = (req.nextUrl.searchParams.get("track") ?? "").trim();
  if (!artist && !track) return NextResponse.json({ error: "Enter an artist and/or track" }, { status: 400 });
  try {
    return NextResponse.json({ results: await lookupTracks(artist, track) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { add } = await req.json().catch(() => ({})) as { add?: LookupResult };
  if (!add?.title) return NextResponse.json({ error: "add (lookup result) required" }, { status: 400 });
  try {
    const result = await addLookupTrack(add);
    return NextResponse.json(result, { status: result.error && !result.addedToLibrary && !result.addedToSpotify ? 502 : 200 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
