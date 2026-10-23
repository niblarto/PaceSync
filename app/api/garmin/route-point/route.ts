import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { loadGarminConfig } from "@/lib/garmin-config";
import { getRouteGraph } from "@/lib/route-graph-cache";
import { runsNear, WAYPOINT_RADIUS_M } from "@/lib/route-graph";

export const dynamic = "force-dynamic";

// How many of your runs pass within the waypoint radius of a point — shown as
// a tooltip while placing a waypoint. GET ?lat=&lng=[&radius=50]
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const lat = parseFloat(req.nextUrl.searchParams.get("lat") ?? "");
  const lng = parseFloat(req.nextUrl.searchParams.get("lng") ?? "");
  if (isNaN(lat) || isNaN(lng)) return NextResponse.json({ error: "lat and lng required" }, { status: 400 });
  const radius = Math.min(200, Math.max(10, parseFloat(req.nextUrl.searchParams.get("radius") ?? "") || WAYPOINT_RADIUS_M));

  const config = loadGarminConfig();
  if (!config) return NextResponse.json({ error: "Garmin DB not configured" }, { status: 404 });
  try {
    const graph = getRouteGraph(config.dbPath);
    if (!graph) return NextResponse.json({ runs: 0, total: 0, radius });
    return NextResponse.json({ runs: runsNear(graph, lat, lng, radius), total: graph.runCount, radius });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
