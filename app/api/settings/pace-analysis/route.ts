import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getPlayedTracksNearPace } from "@/lib/todays-run-history";
import { loadCadenceBuckets, loadCadenceBucketStats } from "@/lib/ai-dj-mix";
import { paceToTargetBpm, explainTargetBpm, classifyPaceFit, PACE_ANALYSIS_WINDOW_SEC as PACE_WINDOW_SEC } from "@/lib/pace-analysis";
import { loadBpmOverrides, paceBpmKey, PACE_BPM_MIN_SEC, PACE_BPM_MAX_SEC } from "@/lib/bpm-overrides";
import { readAllTracks } from "@/lib/tracks-store";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const paceParam = req.nextUrl.searchParams.get("pace") ?? "";
  const m = paceParam.match(/^(\d+):(\d{1,2})$/);
  if (!m) {
    return NextResponse.json({ error: "pace required as M:SS (e.g. 8:30)" }, { status: 400 });
  }
  const paceSec = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  if (paceSec < 180 || paceSec > 1200) {
    return NextResponse.json({ error: "pace out of range (3:00-20:00 /mi)" }, { status: 400 });
  }

  const cadenceBuckets = loadCadenceBuckets();
  const targetBpm = paceToTargetBpm(paceSec, cadenceBuckets);

  // A played-history URI can outlive the track it points at — deleted from
  // the library since, or from a playlist that's no longer the active one —
  // in which case it can never be reused in a new mix. Filtering to the
  // current library keeps this list meaningful (and matches what Pace Pro's
  // candidate feed uses, so the two stay consistent).
  const libraryUris = new Set(readAllTracks(loadRunningPlaylistConfig().csvFile).map(t => t.uri));

  const tracks = getPlayedTracksNearPace(paceSec, PACE_WINDOW_SEC)
    .filter(t => t.uri && libraryUris.has(t.uri))
    .map(t => ({ ...t, ...classifyPaceFit(t.tempo, targetBpm) }))
    .sort((a, b) => a.diff - b.diff);

  return NextResponse.json({
    paceSec, targetBpm,
    // What's SAVED for this pace in the Pace BPM table (what mixes actually use).
    tableBpm: (() => {
      if (paceSec < PACE_BPM_MIN_SEC - 2.5 || paceSec > PACE_BPM_MAX_SEC + 2.5) return null;
      const snapped = Math.min(Math.max(Math.round(paceSec / 5) * 5, PACE_BPM_MIN_SEC), PACE_BPM_MAX_SEC);
      const key = paceBpmKey(snapped);
      return { key, bpm: loadBpmOverrides().paceBpm?.[key] ?? null };
    })(),
    basis: (() => {
      const b = explainTargetBpm(paceSec, cadenceBuckets);
      const stats = b.bucketSec != null ? loadCadenceBucketStats(b.bucketSec) : null;
      return { ...b, runs: stats?.runs, records: stats?.records };
    })(),
    cadenceSource: cadenceBuckets ? "garmin" : "fallback",
    windowSec: PACE_WINDOW_SEC,
    tracks,
    fitsCount: tracks.filter(t => t.fit === "fits").length,
    tooSlowCount: tracks.filter(t => t.fit === "too-slow").length,
  });
}
