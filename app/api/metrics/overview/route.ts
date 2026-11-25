import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { buildMetricsOverview } from "@/lib/metrics-dashboard";

export const dynamic = "force-dynamic";

// GET ?days=14 (7-30) → daily health and activity metrics, activities and heart-rate / stress heatmaps: the data
// behind the Metrics page.
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const n = Number(req.nextUrl.searchParams.get("days") ?? 14);
  const days = Number.isFinite(n) ? Math.min(30, Math.max(7, Math.round(n))) : 14;
  try {
    return NextResponse.json(await buildMetricsOverview(days));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
