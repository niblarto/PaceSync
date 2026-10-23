import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { loadGarminConfig } from "@/lib/garmin-config";
import { getRouteGraph } from "@/lib/route-graph-cache";
import { loadOrsKey, orsRateInfo } from "@/lib/ors";
import { finishRoutes } from "@/lib/route-finish";
import { familiarityOf, firstUnreachableLeg, generatedWaypoints, MAX_WAYPOINTS, nearestNode, suggestLoops } from "@/lib/route-graph";

// New loop routes of a requested distance, stitched together from the paths
// in the user's own recorded runs. GET ?distanceMi=6.2[&seed=n][&lat=&lng=][&endLat=&endLng=][&minRuns=2][&waypoints=2][&via=lat,lng|lat,lng]

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const distanceMi = parseFloat(req.nextUrl.searchParams.get("distanceMi") ?? "");
  if (!distanceMi || distanceMi < 1 || distanceMi > 30) {
    return NextResponse.json({ error: "distanceMi required (1–30)" }, { status: 400 });
  }
  const minRuns = Math.min(50, Math.max(1, parseInt(req.nextUrl.searchParams.get("minRuns") ?? "") || 2));
  const waypoints = Math.min(5, Math.max(1, parseInt(req.nextUrl.searchParams.get("waypoints") ?? "") || 2));
  // via=lat,lng|lat,lng — waypoints the route must pass through, in order.
  const viaPts = (req.nextUrl.searchParams.get("via") ?? "")
    .split("|")
    .map(v => v.split(",").map(parseFloat))
    .filter(v => v.length === 2 && !isNaN(v[0]) && !isNaN(v[1]))
    .slice(0, 8);
  const snap = req.nextUrl.searchParams.get("snap") === "1";
  const avoidLights = req.nextUrl.searchParams.get("avoidLights") === "1";
  const preferParks = req.nextUrl.searchParams.get("preferParks") === "1";
  const seedParam = parseInt(req.nextUrl.searchParams.get("seed") ?? "");
  const lat = parseFloat(req.nextUrl.searchParams.get("lat") ?? "");
  const lng = parseFloat(req.nextUrl.searchParams.get("lng") ?? "");
  const endLat = parseFloat(req.nextUrl.searchParams.get("endLat") ?? "");
  const endLng = parseFloat(req.nextUrl.searchParams.get("endLng") ?? "");

  const config = loadGarminConfig();
  if (!config) return NextResponse.json({ error: "Garmin DB not configured" }, { status: 404 });

  try {
    // Built once and cached (activities you excluded are left out of it).
    const graph = getRouteGraph(config.dbPath);
    if (!graph) return NextResponse.json({ error: "No GPS data in your running history yet" }, { status: 404 });

    const start = !isNaN(lat) && !isNaN(lng) ? nearestNode(graph, lat, lng, minRuns) : graph.home;
    const end = !isNaN(endLat) && !isNaN(endLng) ? nearestNode(graph, endLat, endLng, minRuns) : undefined;
    const via = viaPts.map(v => nearestNode(graph, v[0], v[1], minRuns));
    const search = (n: number, budgetMs?: number) => suggestLoops(graph, distanceMi, {
      start,
      end,
      via,
      minRuns,
      waypoints: n,
      budgetMs,
      seed: isNaN(seedParam) ? undefined : seedParam,
    });
    let routes = search(waypoints);
    // Nothing found: add generated waypoints and try again, until a route
    // turns up or the limit is reached. Only counts that actually change how
    // many are generated are tried, and each retry gets a shorter budget.
    let usedWaypoints = waypoints;
    let escalation: string | undefined;
    if (routes.length === 0) {
      let free = generatedWaypoints(waypoints, via.length, distanceMi);
      for (let n = waypoints + 1; n <= MAX_WAYPOINTS && routes.length === 0; n++) {
        const f = generatedWaypoints(n, via.length, distanceMi);
        if (f === free) continue;
        free = f;
        routes = search(n, 4000);
        if (routes.length > 0) usedWaypoints = n;
      }
      escalation = routes.length > 0
        ? `No route with ${waypoints} waypoint${waypoints === 1 ? "" : "s"} — found with ${usedWaypoints}.`
        : `No route found, even with up to ${MAX_WAYPOINTS} waypoints.`;
    }
    // Optionally snap each route onto real streets (OpenRouteService), then
    // score them all (RunPaths-style) and sort best-first.
    const orsKey = snap ? loadOrsKey() : null;
    const finished = await finishRoutes(routes, {
      targetM: distanceMi * 1609.344,
      source: "runs",
      snapKey: orsKey,
      avoidLights,
      preferParks,
      familiarity: orsKey ? pts => familiarityOf(graph, pts, minRuns) : undefined,
    });
    const notes: string[] = [];
    if (escalation) notes.push(escalation);
    if (snap && !orsKey) notes.push("Add an OpenRouteService key in Settings → Integrations to snap routes to streets.");
    if (finished.note) notes.push(finished.note);
    const rate = orsRateInfo();
    if (orsKey && rate) notes.push(`OpenRouteService requests left: ${rate.remaining}${rate.limit ? ` of ${rate.limit}` : ""}.`);

    // Say why, when placed waypoints are the reason nothing came back.
    let note: string | undefined;
    if (routes.length === 0 && via.length > 0) {
      const leg = firstUnreachableLeg(graph, start, via, end ?? start, minRuns);
      if (leg >= 0) {
        note = `${leg === 0 ? "The start" : `Waypoint ${leg}`} and ${leg === via.length ? "the end" : `waypoint ${leg + 1}`} aren't joined by paths run ${minRuns}+ times — lower the run count or move a waypoint.`;
      }
    }
    return NextResponse.json({
      note: [note, ...notes].filter(Boolean).join(" ") || undefined,
      start: [graph.lat[start], graph.lng[start]],
      end: end === undefined ? null : [graph.lat[end], graph.lng[end]],
      runs: graph.runCount,
      nodes: graph.lat.length,
      routes: finished.routes,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
