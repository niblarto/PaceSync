import { garminCacheGet, garminCacheSet } from "@/lib/garmin-cache";
import { loadRouteExcluded } from "@/lib/route-excluded";
import { buildRouteGraph, type RouteGraph } from "@/lib/route-graph";

// The GPS path graph is the expensive part (one pass over every GPS record),
// so it's built once and kept in the garmin cache. It's rebuilt when the
// Garmin DB changes or the excluded-activities list does. Returns null when
// there's no GPS history.
export function getRouteGraph(dbPath: string): RouteGraph | null {
  const sig = loadRouteExcluded().slice().sort().join(",");
  let cached = garminCacheGet<{ sig: string; graph: RouteGraph | null }>("route-graph", dbPath);
  if (!cached || cached.sig !== sig) {
    cached = { sig, graph: buildRouteGraph(dbPath, new Set(sig ? sig.split(",") : [])) };
    garminCacheSet("route-graph", dbPath, cached);
  }
  return cached.graph;
}

// The graph if it has already been built (never triggers a build).
export function peekRouteGraph(dbPath: string): RouteGraph | null {
  const sig = loadRouteExcluded().slice().sort().join(",");
  const cached = garminCacheGet<{ sig: string; graph: RouteGraph | null }>("route-graph", dbPath);
  return cached && cached.sig === sig ? cached.graph : null;
}
