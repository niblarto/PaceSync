import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { refreshGarminWeights } from "@/lib/garmin-weight";
import { clearMetricsLiveCache } from "@/lib/metrics-live";

export const dynamic = "force-dynamic";

// POST → the Metrics page's refresh button: pull the latest weigh-ins from Garmin Connect and drop the cached "today"
// data, so the next read comes straight from the Garmin API. (GarminDB itself is only filled by the nightly sync.)
export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  clearMetricsLiveCache();
  const weights = await refreshGarminWeights(30).catch(e => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
  return NextResponse.json({ ok: true, weights: weights.ok ? "refreshed" : `not refreshed: ${weights.error}` });
}
