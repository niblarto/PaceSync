import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { loadGarminConfig } from "@/lib/garmin-config";
import { getRouteGraph } from "@/lib/route-graph-cache";
import { parseKinds, exactNode, nearestNode, shortestPathNodes } from "@/lib/route-graph";
import { loadOrsKey, orsDirections } from "@/lib/ors";

export const dynamic = "force-dynamic";

// One leg of a hand-drawn route (Route Finder's "Draw route" tab): the way from one clicked point to the next.
// follow: along paths in your own runs (run `minRuns`+ times); otherwise along real streets (OpenRouteService).
// POST { from, to, follow, minRuns?, exactFrom? } → { points, start, end } — start/end are where the leg really
// begins and ends (snapped onto the path), so the next leg can carry on from the same spot. `exactFrom` says
// `from` already is a snapped position on your paths and must be used as is.

type LatLng = [number, number];

function asPoint(v: unknown): LatLng | null {
  return Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number" ? [v[0], v[1]] : null;
}

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({})) as { from?: unknown; to?: unknown; follow?: boolean; minRuns?: number; exactFrom?: boolean; kinds?: string };
  const from = asPoint(b.from), to = asPoint(b.to);
  if (!from || !to) return NextResponse.json({ error: "from and to required" }, { status: 400 });

  try {
    if (b.follow) {
      const config = loadGarminConfig();
      if (!config) return NextResponse.json({ error: "Garmin DB not configured" }, { status: 404 });
      const g = getRouteGraph(config.dbPath, parseKinds(b.kinds));
      if (!g) return NextResponse.json({ error: "No GPS data in your history for that activity type yet" }, { status: 404 });
      const minRuns = Math.min(50, Math.max(1, Math.round(b.minRuns ?? 2)));
      const a = b.exactFrom ? exactNode(g, from[0], from[1]) : nearestNode(g, from[0], from[1], minRuns);
      const z = nearestNode(g, to[0], to[1], minRuns);
      const nodes = shortestPathNodes(g, a, z, minRuns);
      if (!nodes) {
        return NextResponse.json({ error: `No path you've run ${minRuns}+ times joins those two points — move the point, or lower the run count.` }, { status: 422 });
      }
      const points = nodes.map(n => [g.lat[n], g.lng[n]] as LatLng);
      return NextResponse.json({ points, start: points[0], end: points[points.length - 1] });
    }

    const key = loadOrsKey();
    if (!key) return NextResponse.json({ error: "Street routing needs an OpenRouteService key — add one in Settings → Integrations." }, { status: 400 });
    const r = await orsDirections([from, to], key);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
    const points = r.route.points;
    return NextResponse.json({ points, start: points[0], end: points[points.length - 1] });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
