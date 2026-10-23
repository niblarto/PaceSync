import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { loadGarminConfig } from "@/lib/garmin-config";
import { peekRouteGraph } from "@/lib/route-graph-cache";
import { familiarityOf, type RouteCandidate } from "@/lib/route-graph";
import { loadOrsKey, mapLimited, orsDirections, orsRateInfo, orsRoundTrip, type LatLng, type OrsResult } from "@/lib/ors";
import { retraceShare, roundness } from "@/lib/route-score";
import { finishRoutes } from "@/lib/route-finish";

export const dynamic = "force-dynamic";

// New routes of a requested distance on real streets (OpenRouteService), from
// a start (and optionally an end and waypoints) — not built from your runs.
// GET ?distanceMi=6&lat=&lng=[&endLat=&endLng=][&via=lat,lng|lat,lng]
//     [&avoidLights=1][&preferParks=1][&seed=n]

const M_PER_MI = 1609.344;
const TOL = 0.06;
const MAX_DETOUR_ATTEMPTS = 4; // ORS requests are scarce, so keep each search small

function offset(p: LatLng, bearingRad: number, metres: number): LatLng {
  return [
    p[0] + (metres * Math.cos(bearingRad)) / 110540,
    p[1] + (metres * Math.sin(bearingRad)) / (111320 * Math.cos((p[0] * Math.PI) / 180)),
  ];
}

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const q = req.nextUrl.searchParams;
  const distanceMi = parseFloat(q.get("distanceMi") ?? "");
  if (!distanceMi || distanceMi < 1 || distanceMi > 30) {
    return NextResponse.json({ error: "distanceMi required (1–30)" }, { status: 400 });
  }
  const lat = parseFloat(q.get("lat") ?? ""), lng = parseFloat(q.get("lng") ?? "");
  if (isNaN(lat) || isNaN(lng)) return NextResponse.json({ error: "Set a start point on the map first" }, { status: 400 });
  const endLat = parseFloat(q.get("endLat") ?? ""), endLng = parseFloat(q.get("endLng") ?? "");
  const end: LatLng | null = !isNaN(endLat) && !isNaN(endLng) ? [endLat, endLng] : null;
  const via: LatLng[] = (q.get("via") ?? "")
    .split("|")
    .map(v => v.split(",").map(parseFloat))
    .filter(v => v.length === 2 && !isNaN(v[0]) && !isNaN(v[1]))
    .slice(0, 8)
    .map(v => [v[0], v[1]] as LatLng);
  const seedParam = parseInt(q.get("seed") ?? "");
  const seed = isNaN(seedParam) ? Math.floor(Math.random() * 1e6) : seedParam;
  const start: LatLng = [lat, lng];
  const targetM = distanceMi * M_PER_MI;

  const key = loadOrsKey();
  if (!key) return NextResponse.json({ error: "Add an OpenRouteService key in Settings → Integrations first" }, { status: 400 });

  const raw: { points: LatLng[]; distanceM: number }[] = [];
  let note: string | undefined;
  const fail = (r: OrsResult) => (r.ok ? null : r.error);
  let firstError: string | null = null;

  if (!end && via.length === 0) {
    // Loop from the start: ORS round trips, one per seed (as RunPaths does).
    const roundTrips = async (lengthM: number, seeds: number[]) =>
      mapLimited(seeds, 3, i => orsRoundTrip(start, lengthM, seed + i, key));
    const first = await roundTrips(targetM, [0, 1, 2, 3, 4]);
    for (const r of first) {
      if (r.ok) raw.push(r.route);
      else firstError = firstError ?? fail(r);
    }
    // ORS tends to return loops shorter than asked for (about 9% in testing),
    // so ask again with the length scaled by how far off the first batch was.
    if (raw.length > 0) {
      const ratio = raw.reduce((sum, r) => sum + r.distanceM, 0) / raw.length / targetM;
      if (Math.abs(ratio - 1) > 0.04) {
        for (const r of await roundTrips(targetM / ratio, [10, 11, 12])) if (r.ok) raw.push(r.route);
      }
    }
  } else {
    // Start → waypoints → end (or back to the start), with a generated detour
    // waypoint added to make up the distance.
    const chain: LatLng[] = [start, ...via, end ?? start];
    const base = await orsDirections(chain, key);
    if (!base.ok) return NextResponse.json({ error: base.error }, { status: 502 });
    const baseM = base.route.distanceM;
    if (Math.abs(baseM - targetM) / targetM <= TOL) raw.push(base.route);
    if (baseM > targetM * (1 + TOL)) {
      note = `Going start → end${via.length ? " through your waypoints" : ""} is already ${(baseM / M_PER_MI).toFixed(1)} mi, longer than ${distanceMi} mi.`;
    } else if (baseM < targetM * (1 - TOL)) {
      const rnd0 = ((seed % 360) * Math.PI) / 180;
      const attempts = Array.from({ length: MAX_DETOUR_ATTEMPTS }, (_, k) => k);
      const results = await mapLimited(attempts, 2, async k => {
        const bearing = rnd0 + (k * 2 * Math.PI) / MAX_DETOUR_ATTEMPTS;
        const gap = k % (chain.length - 1);
        const P = chain[gap], Q = chain[gap + 1];
        const mid: LatLng = [(P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2];
        let r = (targetM - baseM) / 2.6;
        let last: OrsResult | null = null;
        for (let it = 0; it < 2; it++) {
          const w = offset(mid, bearing, r);
          const res = await orsDirections([...chain.slice(0, gap + 1), w, ...chain.slice(gap + 1)], key);
          last = res;
          if (!res.ok) return res;
          if (Math.abs(res.route.distanceM - targetM) / targetM <= TOL) return res;
          const grew = Math.max(1, res.route.distanceM - baseM);
          r *= Math.max(0.4, Math.min(2.5, (targetM - baseM) / grew));
        }
        return last!;
      });
      for (const r of results) {
        if (r.ok) raw.push(r.route);
        else firstError = firstError ?? fail(r);
      }
    }
  }

  if (raw.length === 0) {
    return NextResponse.json({ routes: [], note: note ?? undefined, error: firstError ?? undefined }, { status: firstError ? 502 : 200 });
  }

  const candidates: RouteCandidate[] = raw.map(r => ({
    points: r.points,
    distanceMi: r.distanceM / M_PER_MI,
    overlapPct: Math.round(retraceShare(r.points) * 100),
    familiarPct: -1,
    compactness: end ? 1 : Math.round(roundness(r.points) * 100) / 100,
    isLoop: !end,
  }));

  // How much of each route you've run before — only when the GPS graph is
  // already built (it's slow to build, and not needed for these routes).
  const config = loadGarminConfig();
  const graph = config ? peekRouteGraph(config.dbPath) : null;
  const finished = await finishRoutes(candidates, {
    targetM,
    source: "streets",
    avoidLights: q.get("avoidLights") === "1",
    preferParks: q.get("preferParks") === "1",
    familiarity: graph ? pts => familiarityOf(graph!, pts, 2) : () => null,
  });

  // Dedupe near-identical routes (same length to 0.1 mi and same midpoint).
  const seen = new Set<string>();
  const routes = finished.routes.filter(r => {
    const mid = r.points[Math.floor(r.points.length / 2)];
    const k = `${r.distanceMi.toFixed(1)}|${mid[0].toFixed(3)},${mid[1].toFixed(3)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 6);

  const rate = orsRateInfo();
  return NextResponse.json({
    start,
    end,
    routes,
    note: [note, finished.note, rate ? `OpenRouteService requests left: ${rate.remaining}${rate.limit ? ` of ${rate.limit}` : ""}.` : null].filter(Boolean).join(" ") || undefined,
    error: undefined,
  });
}
