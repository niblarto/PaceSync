import { garminCacheGet, garminCacheSet } from "@/lib/garmin-cache";
import { loadRouteExcluded } from "@/lib/route-excluded";
import { buildRouteGraph, type ActivityKinds, type RouteGraph } from "@/lib/route-graph";

// The GPS path graph is the expensive part (one pass over every GPS record),
// so it's built once per activity mix (runs / walks / both) and kept in the
// garmin cache. It's rebuilt when the Garmin DB changes or the excluded-
// activities list does. Returns null when there's no GPS history.
const cacheKey = (kinds: ActivityKinds) => (kinds === "runs" ? "route-graph" : `route-graph-${kinds}`);

export function getRouteGraph(dbPath: string, kinds: ActivityKinds = "runs"): RouteGraph | null {
  const sig = loadRouteExcluded().slice().sort().join(",");
  let cached = garminCacheGet<{ sig: string; graph: RouteGraph | null }>(cacheKey(kinds), dbPath);
  if (!cached || cached.sig !== sig) {
    cached = { sig, graph: buildRouteGraph(dbPath, new Set(sig ? sig.split(",") : []), kinds) };
    garminCacheSet(cacheKey(kinds), dbPath, cached);
  }
  return cached.graph;
}

// The graph if it has already been built (never triggers a build).
export function peekRouteGraph(dbPath: string, kinds: ActivityKinds = "runs"): RouteGraph | null {
  const sig = loadRouteExcluded().slice().sort().join(",");
  const cached = garminCacheGet<{ sig: string; graph: RouteGraph | null }>(cacheKey(kinds), dbPath);
  return cached && cached.sig === sig ? cached.graph : null;
}
