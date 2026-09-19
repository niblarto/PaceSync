import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getPlayedTracksNearPace } from "@/lib/todays-run-history";
import { loadCadenceBuckets } from "@/lib/ai-dj-mix";
import { paceAnalysisFitUris, PACE_ANALYSIS_WINDOW_SEC } from "@/lib/pace-analysis";
import { readAllTracks } from "@/lib/tracks-store";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";

// Batched version of /api/settings/pace-analysis, for Pace Pro: given every
// split's pace (seconds/mile) in one request, returns each split's "fits"
// URI list (same rule the Pace Analysis tab shows) in the same order, so
// the mix build can hand them straight to buildAiDjMix as
// segmentCandidateUris — one Garmin cadence-buckets lookup shared across
// every split instead of one HTTP round-trip per split.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { paceSecs } = await req.json() as { paceSecs?: number[] };
  if (!Array.isArray(paceSecs) || paceSecs.length === 0) {
    return NextResponse.json({ error: "paceSecs (array of seconds/mile) required" }, { status: 400 });
  }

  const cadenceBuckets = loadCadenceBuckets();
  // Same current-library filter as /api/settings/pace-analysis — a stale
  // (deleted-since) URI can't be used as a mix candidate, so excluding it
  // here means the fallback-to-full-library check in
  // ai_dj/workout.py's build_workout_playlist sees an accurate "is this
  // list actually enough to fill the segment" picture instead of counting
  // tracks that would just be silently dropped anyway.
  const libraryUris = new Set(readAllTracks(loadRunningPlaylistConfig().csvFile).map(t => t.uri));
  const results = paceSecs.map(paceSec => {
    if (typeof paceSec !== "number" || !(paceSec > 0)) return { paceSec, uris: [] as string[] };
    const tracks = getPlayedTracksNearPace(paceSec, PACE_ANALYSIS_WINDOW_SEC)
      .filter(t => t.uri && libraryUris.has(t.uri));
    return { paceSec, uris: paceAnalysisFitUris(paceSec, cadenceBuckets, tracks) };
  });

  return NextResponse.json({ results });
}
