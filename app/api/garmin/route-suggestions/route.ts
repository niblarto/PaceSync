import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { loadGarminConfig } from "@/lib/garmin-config";
import { getRouteGraph } from "@/lib/route-graph-cache";
import { loadOrsKey, orsRateInfo } from "@/lib/ors";
import { applyWaterFilter } from "@/lib/route-water";
import { findStreet } from "@/lib/route-street";
import { finishRoutes } from "@/lib/route-finish";
import { parseKinds, runsNear, familiarityOf, firstUnreachableLeg, MAX_GENERATED_WAYPOINTS, minGeneratedWaypoints, nearestNode, suggestLoops } from "@/lib/route-graph";

// New loop routes of a requested distance, stitched together from the paths
// in the user's own recorded runs. GET ?distanceMi=6.2[&seed=n][&lat=&lng=][&endLat=&endLng=][&minRuns=2][&via=lat,lng|lat,lng]

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const distanceMi = parseFloat(req.nextUrl.searchParams.get("distanceMi") ?? "");
  if (!distanceMi || distanceMi < 1 || distanceMi > 30) {
    return NextResponse.json({ error: "distanceMi required (1–30)" }, { status: 400 });
  }
  const minRuns = Math.min(50, Math.max(1, parseInt(req.nextUrl.searchParams.get("minRuns") ?? "") || 2));
  // via=lat,lng|lat,lng — waypoints the route must pass through, in order.
  const viaPts = (req.nextUrl.searchParams.get("via") ?? "")
    .split("|")
    .map(v => v.split(",").map(parseFloat))
    .filter(v => v.length === 2 && !isNaN(v[0]) && !isNaN(v[1]))
    .slice(0, 8);
  const kinds = parseKinds(req.nextUrl.searchParams.get("kinds"));
  const snap = req.nextUrl.searchParams.get("snap") === "1";
  // heading=N|NE|E|SE|S|SW|W|NW — favour routes that lie that way from the start (e.g. "to the south").
  const HEADINGS: Record<string, [number, number]> = { N: [0, 1], NE: [0.7071, 0.7071], E: [1, 0], SE: [0.7071, -0.7071], S: [0, -1], SW: [-0.7071, -0.7071], W: [-1, 0], NW: [-0.7071, 0.7071] };
  const headingKey = (req.nextUrl.searchParams.get("heading") ?? "").toUpperCase();
  const heading = HEADINGS[headingKey] ?? null;
  // street=Acacia Way (up to two) — roads the route should run along; each is looked up on OpenStreetMap near the start.
  const streetNames = req.nextUrl.searchParams.getAll("street").map(x => x.trim()).filter(Boolean).slice(0, 2);
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
    const graph = getRouteGraph(config.dbPath, kinds);
    if (!graph) return NextResponse.json({ error: `No GPS data in your ${kinds === "walks" ? "walking" : kinds === "both" ? "running or walking" : "running"} history yet` }, { status: 404 });

    // Drop links that cross a canal or river without a bridge (checked once per area, then remembered).
    const water = await applyWaterFilter(graph).catch(() => ({ removed: 0, note: undefined as string | undefined }));

    const start = !isNaN(lat) && !isNaN(lng) ? nearestNode(graph, lat, lng, minRuns) : graph.home;
    const end = !isNaN(endLat) && !isNaN(endLng) ? nearestNode(graph, endLat, endLng, minRuns) : undefined;
    const via = viaPts.map(v => nearestNode(graph, v[0], v[1], minRuns));
    const streetNotes: string[] = [];
    for (const name of streetNames) {
      const pts = await findStreet(name, [graph.lat[start], graph.lng[start]]);
      if (pts === null) { streetNotes.push(`Couldn't look up "${name}" (OpenStreetMap didn't answer).`); continue; }
      if (pts.length === 0) { streetNotes.push(`No road called "${name}" found within 15 km of the start.`); continue; }
      let best: [number, number] | null = null, bestRuns = 0;
      for (const p of pts) { const n = runsNear(graph, p[0], p[1], 30); if (n > bestRuns) { bestRuns = n; best = p; } }
      if (!best || bestRuns < minRuns) { streetNotes.push(`You haven't run along ${name} ${minRuns}+ times, so it can't be part of a route built from your runs. Lower the run count to allow it.`); continue; }
      if (via.length < 8) via.push(nearestNode(graph, best[0], best[1], minRuns));
      streetNotes.push(`Routes pass through ${name} (run ${bestRuns} times).`);
    }
    // How far, in km, a route's middle lies from the start in the favoured direction (negative = the other way).
    const lat0 = graph.lat[start], lng0 = graph.lng[start];
    const lean = (pts: [number, number][]): number => {
      if (!heading || pts.length === 0) return 0;
      const mLat = pts.reduce((a, p) => a + p[0], 0) / pts.length, mLng = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      const dx = (mLng - lng0) * Math.cos((lat0 * Math.PI) / 180) * 111.32, dy = (mLat - lat0) * 110.54;
      return dx * heading[0] + dy * heading[1];
    };
    const search = (generated: number, budgetMs?: number) => suggestLoops(graph, distanceMi, {
      count: heading ? 14 : undefined,
      start,
      end,
      via,
      minRuns,
      generated,
      budgetMs,
      seed: isNaN(seedParam) ? undefined : seedParam,
    });
    // Through your placed waypoints, adding generated ones as needed: start
    // with the fewest that can work and, if nothing is found, add one more and
    // try again, until a route turns up or the limit is reached. Each retry
    // gets a shorter time budget.
    const minFree = minGeneratedWaypoints(via.length, end !== undefined && end !== start, distanceMi);
    let routes = search(minFree);
    let usedFree = minFree;
    let escalation: string | undefined;
    if (routes.length === 0) {
      for (let f = minFree + 1; f <= MAX_GENERATED_WAYPOINTS && routes.length === 0; f++) {
        routes = search(f, 4000);
        if (routes.length > 0) usedFree = f;
      }
      escalation = routes.length > 0
        ? `Found a route after adding more waypoints (${usedFree} generated).`
        : `No route found, even with ${MAX_GENERATED_WAYPOINTS} generated waypoints.`;
    }
    // Favouring a direction: keep the six that lean furthest that way (the search was asked for more than usual).
    if (heading && routes.length > 6) routes = [...routes].sort((a, b) => lean(b.points) - lean(a.points)).slice(0, 6);
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
    // Then rank by score plus a bonus for leaning the right way (up to 25 points at about a sixth of the distance out).
    if (heading) {
      const scale = (distanceMi * 1.609344) / 6;
      const rank = (r: (typeof finished.routes)[number]) => (r.score ?? 0) + 25 * Math.max(-1, Math.min(1, lean(r.points) / scale));
      finished.routes = [...finished.routes].sort((a, b) => rank(b) - rank(a));
    }
    const notes: string[] = [...streetNotes];
    if (water.note) notes.push(water.note);
    if (water.removed > 0) notes.push(`Removed ${water.removed} links that crossed canals or rivers without a bridge.`);
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
