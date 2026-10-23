import type { RouteCandidate } from "@/lib/route-graph";
import { mapLimited, orsDirections, sampleWaypoints, type LatLng } from "@/lib/ors";
import {
  countLights, loadOsmContext, parkAdjacency, retraceShare, roundness, routeQuality, scoreRoute,
} from "@/lib/route-score";

const M_PER_MI = 1609.344;

export interface FinishOptions {
  targetM: number;
  source: "runs" | "streets";
  /** ORS key: when set, each route is snapped onto real streets first. */
  snapKey?: string | null;
  avoidLights: boolean;
  preferParks: boolean;
  /** 0–1 share of a route on ground you've run, when it can be measured. */
  familiarity?: (points: LatLng[]) => number | null;
}

// The step both route modes share: optionally snap to streets, then score
// every route and sort best-first.
export async function finishRoutes(routes: RouteCandidate[], o: FinishOptions): Promise<{ routes: RouteCandidate[]; note?: string }> {
  let note: string | undefined;
  let list = routes.map(r => ({ ...r }));

  if (o.snapKey) {
    const key = o.snapKey;
    const snapped = await mapLimited(list, 3, async r => orsDirections(sampleWaypoints(r.points), key));
    let failed: string | null = null;
    list = list.map((r, i) => {
      const s = snapped[i];
      if (!s.ok) { failed = failed ?? s.error; return r; }
      return {
        ...r,
        points: s.route.points,
        distanceMi: s.route.distanceM / M_PER_MI,
        overlapPct: Math.round(retraceShare(s.route.points) * 100),
        compactness: r.isLoop ? Math.round(roundness(s.route.points) * 100) / 100 : 1,
        snapped: true,
      };
    });
    if (failed) note = `Couldn't snap some routes to streets: ${failed}`;
  }

  let osm = null;
  if (o.avoidLights || o.preferParks) {
    osm = await loadOsmContext(list.map(r => r.points));
    if (!osm) note = (note ? note + " " : "") + "Couldn't load traffic lights/parks from OpenStreetMap, so they were ignored.";
  }

  const scored = list.map(r => {
    const lights = osm ? countLights(r.points, osm) : null;
    const parks = osm ? parkAdjacency(r.points, osm) : null;
    const fam = o.familiarity ? o.familiarity(r.points) : r.familiarPct / 100;
    return {
      ...r,
      source: o.source,
      lights,
      parkPct: parks === null ? null : Math.round(parks * 100),
      familiarPct: fam === null ? r.familiarPct : Math.round(fam * 100),
      score: scoreRoute({
        distanceM: r.distanceMi * M_PER_MI,
        targetM: o.targetM,
        quality: routeQuality(r.points),
        familiarity: fam,
        lights,
        avoidLights: o.avoidLights,
        parks,
        preferParks: o.preferParks,
      }),
    };
  });
  scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return { routes: scored, note };
}
