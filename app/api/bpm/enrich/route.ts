import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { fetchFeatures, TrackQuery } from "@/lib/track-enrich";

// Audio features for Spotify tracks via ReccoBeats with a Deezer-ISRC
// fallback — the lookup logic lives in lib/track-enrich (shared with the
// CSV heal sweep).

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { ids?: string[]; tracks?: TrackQuery[] };
  const queries: TrackQuery[] = body.tracks ?? (body.ids ?? []).map(id => ({ id }));
  if (queries.length === 0) return NextResponse.json({ error: "No tracks" }, { status: 400 });

  try {
    const features = await fetchFeatures(queries);
    return NextResponse.json({ features });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
