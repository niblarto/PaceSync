import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadCadenceBuckets } from "@/lib/ai-dj-mix";
import { paceToTargetBpm } from "@/lib/pace-analysis";
import { PACE_BPM_KEYS, PACE_BPM_MIN_SEC, PACE_BPM_STEP_SEC, paceBpmKey } from "@/lib/bpm-overrides";

// Settings -> BPM's Pace BPM table: the suggested BPM beside each pace —
// the same cadence-derived target Pace Analysis shows for that pace.
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const buckets = loadCadenceBuckets();
  const suggestions: Record<string, number> = {};
  PACE_BPM_KEYS.forEach((key, i) => {
    const sec = PACE_BPM_MIN_SEC + i * PACE_BPM_STEP_SEC;
    suggestions[paceBpmKey(sec)] = paceToTargetBpm(sec, buckets);
  });
  return NextResponse.json({ suggestions });
}
