import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { fetchFeatures, resolveByIsrc, TrackQuery, sleep } from "@/lib/track-enrich";

// Audio features for Spotify tracks via ReccoBeats with a Deezer-ISRC
// fallback — the lookup logic lives in lib/track-enrich (shared with the
// CSV heal sweep).
//
// isrcs mode resolves BOTH a Spotify URI and audio features directly from
// an ISRC (no Spotify API call) — used by "search more by this artist"
// (components/DashboardClient.tsx), whose Deezer results carry an ISRC but
// no Spotify ID at all yet.

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { ids?: string[]; tracks?: TrackQuery[]; isrcs?: string[] };

  if (body.isrcs?.length) {
    const results: Record<string, { uri: string; tempo: number; key: number; mode: number; energy: number; danceability: number; valence: number } | null> = {};
    for (let i = 0; i < body.isrcs.length; i++) {
      if (i > 0) await sleep(120);
      try {
        results[body.isrcs[i]] = await resolveByIsrc(body.isrcs[i]);
      } catch {
        results[body.isrcs[i]] = null;
      }
    }
    return NextResponse.json({ resolved: results });
  }

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
