import path from "path";
import { resample } from "@/lib/route-score";

// Street graph learned from the user's own recorded runs, plus a loop finder
// that stitches the paths they've already run into new closed routes of a
// requested distance. No external map data: a node is a ~20 m grid cell that
// at least one run passed through, an edge joins two cells a run went
// between consecutively, and `cnt` is how many distinct runs used that edge.

const CELL_M = 20;
const MIN_STEP_M = 12;   // thin the GPS stream before snapping
const MAX_GAP_M = 40;    // a bigger jump between records is a GPS dropout, not a path
// A watch wanders around the house until it gets a fix, so the first and last
// stretch of every run is noisy. A path seen only in those zones is kept only
// if several runs used it (the real door-to-road path), not one-off wobble.
const ENDS_ZONE_M = 250;
const ENDS_MIN_RUNS = 3;
const M_PER_MI = 1609.344;
const EARTH_RADIUS_M = 6371000;

export interface GraphEdge { to: number; len: number; cnt: number }

export interface RouteGraph {
  lat: number[];
  lng: number[];
  adj: GraphEdge[][];
  /** Node nearest to where most runs start. */
  home: number;
  runCount: number;
  /** For each node, the (1-based) indexes of the distinct runs that pass through it. */
  runsAt: number[][];
}

export interface RouteCandidate {
  points: [number, number][];
  distanceMi: number;
  /** Share of the route that re-traverses its own ground (lower is better). */
  overlapPct: number;
  /** Share of the route on paths run three or more times. */
  familiarPct: number;
  /** 1 = perfectly round loop, near 0 = long thin out-and-back shape. */
  compactness: number;
  /** False for a point-to-point route with a different end. */
  isLoop: boolean;
  // Filled in by lib/route-finish.ts:
  /** 0–100 overall score (distance fit, smoothness, familiarity, lights, parks). */
  score?: number;
  source?: "runs" | "streets";
  /** Geometry was routed onto real streets by OpenRouteService. */
  snapped?: boolean;
  lights?: number | null;
  parkPct?: number | null;
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function buildRouteGraph(dbDir: string, excluded: Set<string> = new Set()): RouteGraph | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const db = new Database(path.join(dbDir, "garmin_activities.db"), { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 30000");

  const lat: number[] = [];
  const lng: number[] = [];
  const hits: number[] = [];
  // Distinct runs through each cell. GPS lane wobble splits a busy road across
  // neighbouring cells, so a link's own run count understates how well-used
  // the road is; the cells' counts don't.
  const nodeRuns: number[] = [];
  const lastRunAtNode: number[] = [];
  const runsAt: number[][] = [];
  const adj: GraphEdge[][] = [];
  const cellIndex = new Map<string, number>();
  const edgeIndex = new Map<string, { a: GraphEdge; b: GraphEdge; lastRun: number; core: number; lastCoreRun: number }>();
  // The current run's edges with how far into the run each one ended, so the
  // run's start/end zones can be worked out once its total length is known.
  let runEdges: { e: { core: number; lastCoreRun: number }; cum: number }[] = [];
  let cum = 0;
  const flushRun = () => {
    for (const re of runEdges) {
      if (cum >= ENDS_ZONE_M && re.cum <= cum - ENDS_ZONE_M && re.cum >= ENDS_ZONE_M && re.e.lastCoreRun !== runCount) {
        re.e.lastCoreRun = runCount;
        re.e.core++;
      }
    }
    runEdges = [];
  };
  const startBuckets = new Map<string, { n: number; lat: number; lng: number }>();

  let lat0 = NaN;
  let lng0 = NaN;
  let mPerLng = 1;
  let runCount = 0;
  let curRun: number | string | null = null;
  let prevNode = -1;
  let prevLat = 0;
  let prevLng = 0;

  const rows = db.prepare(`
    SELECT r.activity_id AS id, r.position_lat AS lat, r.position_long AS lng
    FROM activity_records r
    JOIN activities a ON a.activity_id = r.activity_id
    WHERE LOWER(a.sport) LIKE '%running%'
      AND r.position_lat IS NOT NULL AND r.position_long IS NOT NULL
    ORDER BY r.activity_id, r.record
  `).iterate() as IterableIterator<{ id: number | string; lat: number; lng: number }>;

  // Manual iteration: the build target is ES5 without downlevelIteration.
  for (let it = rows.next(); !it.done; it = rows.next()) {
    const row = it.value;
    if (excluded.size > 0 && excluded.has(String(row.id))) continue;
    if (isNaN(lat0)) {
      lat0 = row.lat;
      lng0 = row.lng;
      mPerLng = Math.cos((lat0 * Math.PI) / 180) * 111320;
    }
    if (row.id !== curRun) {
      flushRun();
      cum = 0;
      curRun = row.id;
      runCount++;
      prevNode = -1;
      const key = `${row.lat.toFixed(3)},${row.lng.toFixed(3)}`;
      const b = startBuckets.get(key);
      if (b) { b.n++; b.lat += row.lat; b.lng += row.lng; }
      else startBuckets.set(key, { n: 1, lat: row.lat, lng: row.lng });
    } else if (prevNode >= 0 && haversineM(prevLat, prevLng, row.lat, row.lng) < MIN_STEP_M) {
      continue;
    }

    const cx = Math.floor(((row.lng - lng0) * mPerLng) / CELL_M);
    const cy = Math.floor(((row.lat - lat0) * 110540) / CELL_M);
    const ck = `${cx},${cy}`;
    let node = cellIndex.get(ck);
    if (node === undefined) {
      node = lat.length;
      cellIndex.set(ck, node);
      lat.push(row.lat);
      lng.push(row.lng);
      hits.push(1);
      nodeRuns.push(0);
      lastRunAtNode.push(-1);
      runsAt.push([]);
      adj.push([]);
    } else {
      const h = ++hits[node];
      lat[node] += (row.lat - lat[node]) / h;
      lng[node] += (row.lng - lng[node]) / h;
    }

    const stepM = prevNode >= 0 ? haversineM(prevLat, prevLng, row.lat, row.lng) : 0;
    cum += stepM;
    if (lastRunAtNode[node] !== runCount) {
      lastRunAtNode[node] = runCount;
      nodeRuns[node]++;
      runsAt[node].push(runCount);
    }
    if (prevNode >= 0 && prevNode !== node && stepM <= MAX_GAP_M) {
      const lo = Math.min(prevNode, node);
      const hi = Math.max(prevNode, node);
      const ek = `${lo}_${hi}`;
      let e = edgeIndex.get(ek);
      if (!e) {
        const ea: GraphEdge = { to: hi, len: 0, cnt: 0 };
        const eb: GraphEdge = { to: lo, len: 0, cnt: 0 };
        adj[lo].push(ea);
        adj[hi].push(eb);
        e = { a: ea, b: eb, lastRun: -1, core: 0, lastCoreRun: -1 };
        edgeIndex.set(ek, e);
      }
      runEdges.push({ e, cum });
      if (e.lastRun !== runCount) {
        e.lastRun = runCount;
        e.a.cnt++;
        e.b.cnt++;
      }
    }
    prevNode = node;
    prevLat = row.lat;
    prevLng = row.lng;
  }
  flushRun();
  db.close();

  // Drop edges only ever seen in run start/end zones unless enough runs used them.
  const dead = new Set<GraphEdge>();
  edgeIndex.forEach(e => {
    if (e.core === 0 && e.a.cnt < ENDS_MIN_RUNS) { dead.add(e.a); dead.add(e.b); }
  });
  if (dead.size > 0) {
    for (let i = 0; i < adj.length; i++) adj[i] = adj[i].filter(e => !dead.has(e));
  }

  if (lat.length === 0 || startBuckets.size === 0) return null;

  // A link counts as well-used when both of its cells are: a one-run wobble
  // through a garden has low-use cells, a real road doesn't.
  for (let a = 0; a < adj.length; a++) {
    for (const e of adj[a]) e.cnt = Math.max(e.cnt, Math.min(nodeRuns[a], nodeRuns[e.to]));
  }

  // Edge lengths use the final (averaged) node positions.
  for (let a = 0; a < adj.length; a++) {
    for (const e of adj[a]) e.len = haversineM(lat[a], lng[a], lat[e.to], lng[e.to]);
  }

  // Default start: the busiest ~100 m bucket of run start points.
  let best: { n: number; lat: number; lng: number } | null = null;
  for (const b of Array.from(startBuckets.values())) if (!best || b.n > best.n) best = b;
  const home = nearestNode({ lat, lng, adj, home: 0, runCount, runsAt }, best!.lat / best!.n, best!.lng / best!.n);

  return { lat, lng, adj, home, runCount, runsAt };
}

// A waypoint is a circle, not a single spot: GPS wobble spreads one road
// across several neighbouring cells (lanes, pavement, cycle path), and a lone
// cell can be a stray. So a clicked point lands on the busiest connected node
// within `radiusM` of it (or within 20 m of the closest node if that is
// further), "busiest" meaning most distinct runs through the cell, needing at
// least `minRuns`. Falls back to the plain nearest connected node.
export const WAYPOINT_RADIUS_M = 50;

export function nearestNode(g: RouteGraph, qLat: number, qLng: number, minRuns = 2, radiusM = WAYPOINT_RADIUS_M): number {
  const dist: number[] = new Array(g.lat.length);
  let nearest = -1;
  let nearestD = Infinity;
  for (let i = 0; i < g.lat.length; i++) {
    dist[i] = Infinity;
    if (g.adj[i].length === 0) continue;
    const d = haversineM(qLat, qLng, g.lat[i], g.lng[i]);
    dist[i] = d;
    if (d < nearestD) { nearestD = d; nearest = i; }
  }
  if (nearest < 0) return 0;
  const reach = Math.min(radiusM + 30, Math.max(nearestD + 20, radiusM));
  let best = -1;
  let bestSupport = 0;
  let bestD = Infinity;
  for (let i = 0; i < g.lat.length; i++) {
    if (dist[i] > reach) continue;
    let support = g.runsAt[i] ? g.runsAt[i].length : 0;
    for (const e of g.adj[i]) if (e.cnt > support) support = e.cnt;
    if (support < minRuns) continue;
    if (support > bestSupport || (support === bestSupport && dist[i] < bestD)) {
      best = i; bestSupport = support; bestD = dist[i];
    }
  }
  return best >= 0 ? best : nearest;
}

// How many distinct runs pass within `radiusM` of a point — the number a
// waypoint placed there would include.
export function runsNear(g: RouteGraph, qLat: number, qLng: number, radiusM: number): number {
  const seen = new Uint8Array(g.runCount + 2);
  let count = 0;
  for (let i = 0; i < g.lat.length; i++) {
    if (haversineM(qLat, qLng, g.lat[i], g.lng[i]) > radiusM) continue;
    for (const r of g.runsAt[i]) if (!seen[r]) { seen[r] = 1; count++; }
  }
  return count;
}

// ---- shortest paths -------------------------------------------------------

class MinHeap {
  private cost: number[] = [];
  private node: number[] = [];
  get size() { return this.cost.length; }
  push(c: number, n: number) {
    const cost = this.cost, node = this.node;
    let i = cost.length;
    cost.push(c);
    node.push(n);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (cost[p] <= c) break;
      cost[i] = cost[p]; node[i] = node[p];
      i = p;
    }
    cost[i] = c; node[i] = n;
  }
  pop(): [number, number] {
    const cost = this.cost, node = this.node;
    const topC = cost[0], topN = node[0];
    const lastC = cost.pop()!, lastN = node.pop()!;
    const len = cost.length;
    if (len > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= len) break;
        if (c + 1 < len && cost[c + 1] < cost[c]) c++;
        if (cost[c] >= lastC) break;
        cost[i] = cost[c]; node[i] = node[c];
        i = c;
      }
      cost[i] = lastC; node[i] = lastN;
    }
    return [topC, topN];
  }
}

interface Tree {
  src: number;
  real: Map<number, number>;   // true metres from src to each reachable point
  path: (n: number) => number[];
}

function pathTo(t: Tree, n: number): number[] {
  return t.path(n);
}

function edgeKey(a: number, b: number): number {
  return a < b ? a * 1048576 + b : b * 1048576 + a;
}

function addPathEdges(used: Set<number>, nodes: number[]) {
  for (let k = 1; k < nodes.length; k++) used.add(edgeKey(nodes[k - 1], nodes[k]));
}

// `used`: edges the route has already run along. They cost USED_PENALTY times
// more, so a later leg only re-runs them when there's no other way (a lollipop
// stem).
const USED_PENALTY = 6;

const BACKTRACK_M = 22;

function withinM(g: RouteGraph, a: number, b: number, m: number): boolean {
  const dy = (g.lat[a] - g.lat[b]) * 110540;
  const dx = (g.lng[a] - g.lng[b]) * 67000;
  return dx * dx + dy * dy < m * m;
}

// Shortest non-backtracking walks from `src`. A state is (where we came from,
// where we are) and a step may not go straight back to where we came from, so
// a walk can pass the same point twice (out a stem, round a loop, back down
// the stem) but never turns round on a road. `prev` is the point the route
// arrived at `src` from (so it can't reverse out of it), `avoidFirst` a
// neighbour of `src` the first step must not use. Cost favours well-run
// edges; real metres are tracked separately. Stops past `maxReal` metres.
function dijkstra(
  g: RouteGraph, src: number, maxReal: number, minRuns: number,
  used?: Set<number>, prev = -1, avoidFirst = -1,
): Tree {
  const K = 1048576;
  const sk = (from: number, at: number) => (from + 1) * K + at;
  const startKey = sk(prev, src);
  const cost = new Map<number, number>([[startKey, 0]]);
  const realS = new Map<number, number>([[startKey, 0]]);
  const parentS = new Map<number, number>();
  const done = new Set<number>();
  const bestState = new Map<number, number>();
  const real = new Map<number, number>();
  const heap = new MinHeap();
  heap.push(0, startKey);
  while (heap.size > 0) {
    const [c, key] = heap.pop();
    if (done.has(key)) continue;
    done.add(key);
    const at = key % K;
    const from = Math.floor(key / K) - 1;
    const rk = realS.get(key)!;
    if (!bestState.has(at)) { bestState.set(at, key); real.set(at, rk); }
    for (const e of g.adj[at]) {
      if (e.cnt < minRuns || e.to === from) continue;
      if (from >= 0 && withinM(g, e.to, from, BACKTRACK_M)) continue; // the parallel lane back is still turning round
      if (key === startKey && e.to === avoidFirst) continue;
      const r = rk + e.len;
      if (r > maxReal) continue;
      const nk = sk(at, e.to);
      if (done.has(nk)) continue;
      const reuse = used && used.size > 0 && used.has(edgeKey(at, e.to)) ? USED_PENALTY : 1;
      const nc = c + e.len * (1.3 - 0.3 * (Math.min(e.cnt, 5) / 5)) * reuse;
      const old = cost.get(nk);
      if (old === undefined || nc < old) {
        cost.set(nk, nc);
        realS.set(nk, r);
        parentS.set(nk, key);
        heap.push(nc, nk);
      }
    }
  }
  const path = (n: number): number[] => {
    let key = bestState.get(n);
    if (key === undefined) return [n];
    const out: number[] = [];
    for (;;) {
      out.push(key % K);
      if (key === startKey) break;
      key = parentS.get(key)!;
    }
    return out.reverse();
  };
  return { src, real, path };
}

// ---- loop search ----------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rnd: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function edgeCount(g: RouteGraph, a: number, b: number): number {
  for (const e of g.adj[a]) if (e.to === b) return e.cnt;
  return 0;
}

export interface SearchStats { evaluated: number; badDistance: number; overlap: number; uturn: number; folds?: number[] }

interface Scored { cand: RouteCandidate; edges: Set<string>; score: number }

// A U-turn is running down a path and turning round to come back the way you
// went (the tip of a dead-end spur). Looking 40 m either side of each point
// ignores GPS-lane wobble: if the two ends are within 25 m of each other the
// route folded back on itself there. Reusing a road later in the same
// direction or opposite (a lollipop's stem) is fine — only the fold is not.
function uTurnAt(g: RouteGraph, nodes: number[]): number {
  const ARM_M = 40;
  const FOLD_M = 25;
  const d = (a: number, b: number) => haversineM(g.lat[a], g.lng[a], g.lat[b], g.lng[b]);
  for (let i = 1; i < nodes.length - 1; i++) {
    let back = i;
    let acc = 0;
    while (back > 0 && acc < ARM_M) { acc += d(nodes[back], nodes[back - 1]); back--; }
    if (acc < ARM_M) continue;
    let fwd = i;
    acc = 0;
    while (fwd < nodes.length - 1 && acc < ARM_M) { acc += d(nodes[fwd], nodes[fwd + 1]); fwd++; }
    if (acc < ARM_M) continue;
    if (d(nodes[back], nodes[fwd]) < FOLD_M) return i;
  }
  return -1;
}

function evaluate(g: RouteGraph, nodes: number[], targetM: number, tol: number, isLoop: boolean, stats?: SearchStats): Scored | null {
  const seen = new Set<string>();
  let total = 0;
  let overlap = 0;
  let familiar = 0;
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1], b = nodes[i];
    const len = haversineM(g.lat[a], g.lng[a], g.lat[b], g.lng[b]);
    const ek = a < b ? `${a}_${b}` : `${b}_${a}`;
    total += len;
    if (seen.has(ek)) overlap += len;
    seen.add(ek);
    if (edgeCount(g, a, b) >= 3) familiar += len;
  }
  if (stats) stats.evaluated++;
  if (total < targetM * (1 - tol) || total > targetM * (1 + tol)) { if (stats) stats.badDistance++; return null; }
  const overlapPct = overlap / total;
  if (overlapPct > 0.3) { if (stats) stats.overlap++; return null; }
  const fold = uTurnAt(g, nodes);
  if (fold >= 0) {
    if (stats) { stats.uturn++; if (stats.folds) stats.folds.push(nodes[fold]); }
    return null;
  }

  // Compactness: 4πA / P² of the loop in a local flat projection.
  const lat0 = g.lat[nodes[0]];
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
  let area = 0;
  for (let i = 1; i < nodes.length; i++) {
    const x1 = g.lng[nodes[i - 1]] * kx, y1 = g.lat[nodes[i - 1]] * 110540;
    const x2 = g.lng[nodes[i]] * kx, y2 = g.lat[nodes[i]] * 110540;
    area += x1 * y2 - x2 * y1;
  }
  const compactness = isLoop ? Math.min(1, (4 * Math.PI * Math.abs(area / 2)) / (total * total)) : 1;
  const familiarPct = familiar / total;

  const score = overlapPct * 2 + (Math.abs(total - targetM) / targetM) * 5 + (1 - compactness) * 0.5 - familiarPct * 0.5;
  return {
    cand: {
      points: nodes.map(n => [g.lat[n], g.lng[n]] as [number, number]),
      distanceMi: total / M_PER_MI,
      overlapPct: Math.round(overlapPct * 100),
      familiarPct: Math.round(familiarPct * 100),
      compactness: Math.round(compactness * 100) / 100,
      isLoop,
    },
    edges: seen,
    score,
  };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of Array.from(a)) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// The most turning points a search will use. The Route Finder's field goes to 5;
// the API raises it up to this when nothing is found.
export const MAX_WAYPOINTS = 8;

// How many waypoints the finder generates itself for `waypoints` turning points
// in total when `viaCount` are yours. Placed waypoints leave less room to tune
// the distance, so there are always at least 1 generated (2 with a placed
// waypoint, 3 from about 9 miles).
export function generatedWaypoints(waypoints: number, viaCount: number, targetMi: number): number {
  const minFree = viaCount === 0 ? 1 : targetMi >= 9 ? 3 : 2;
  return Math.max(minFree, Math.round(waypoints) - viaCount);
}

// Routes start → [your via points, in order] → end, with every leg a shortest
// path (biased to roads the user runs a lot). With no `end` (or end === start)
// that is a loop. Your via points are fixed, so distance can only be tuned by
// extra generated waypoints: they are inserted into one gap of the chain at a
// time, the last of them chosen so the total lands within tolerance of the
// target. `waypoints` is the total number of turning points wanted — your via
// points count toward it, but at least one generated waypoint is always added
// (two when you've placed your own: one alone is too constrained to fit).
// Candidates are kept only if the legs don't retrace or fold back (evaluate).
export function suggestLoops(
  g: RouteGraph,
  targetMi: number,
  opts: {
    start?: number; end?: number; via?: number[]; seed?: number; count?: number;
    budgetMs?: number; minRuns?: number; waypoints?: number; stats?: SearchStats;
  } = {},
): RouteCandidate[] {
  const start = opts.start ?? g.home;
  const end = opts.end ?? start;
  const via = opts.via ?? [];
  const isLoop = end === start;
  const minRuns = opts.minRuns ?? 2;
  const n = Math.min(MAX_WAYPOINTS, Math.max(1, Math.round(opts.waypoints ?? 2)));
  const free = generatedWaypoints(n, via.length, targetMi);
  const count = opts.count ?? 6;
  const rnd = mulberry32(opts.seed ?? Math.floor(Math.random() * 2 ** 31));
  const targetM = targetMi * M_PER_MI;
  const tol = Math.max(0.04, 200 / targetM);
  const t0 = Date.now();
  const deadline = t0 + (opts.budgetMs ?? 6000);

  // The fixed chain and a shortest-path tree from each of its points.
  const fixed = [start, ...via, end];
  const radius = via.length > 0 ? targetM : targetM * 0.75;
  const treeByNode = new Map<number, Tree>();
  const trees = fixed.map(node => {
    let t = treeByNode.get(node);
    if (!t) { t = dijkstra(g, node, radius, minRuns); treeByNode.set(node, t); }
    return t;
  });
  // The fixed legs, built in order: each avoids roads the earlier legs used.
  const chainPaths: number[][] = [];
  const legLen: number[] = [];
  const usedEdges = new Set<number>();
  for (let i = 0; i < fixed.length - 1; i++) {
    const prevLeg = i > 0 ? chainPaths[i - 1] : null;
    const prevNode = prevLeg && prevLeg.length >= 2 ? prevLeg[prevLeg.length - 2] : -1;
    const t = i === 0 ? trees[0] : dijkstra(g, fixed[i], radius, minRuns, usedEdges, prevNode);
    const m = t.real.get(fixed[i + 1]);
    if (m === undefined) return [];
    const leg = pathTo(t, fixed[i + 1]);
    addPathEdges(usedEdges, leg);
    chainPaths.push(leg);
    legLen.push(m);
  }
  const fixedTotal = legLen.reduce((x, y) => x + y, 0);
  if (fixedTotal > targetM * (1 + tol)) return [];

  const found: Scored[] = [];
  const nGaps = fixed.length - 1;
  for (let gap = 0; gap < nGaps; gap++) {
    // Give each gap an equal share of the remaining time.
    const gapDeadline = Date.now() + (deadline - Date.now()) / (nGaps - gap);
    const P = fixed[gap], Q = fixed[gap + 1];
    // Generated stretches avoid roads the rest of the route already uses, so
    // they don't fold back at the waypoints either side of this gap.
    const othersUsed = new Set<number>();
    for (let i = 0; i < nGaps; i++) if (i !== gap) addPathEdges(othersUsed, chainPaths[i]);
    const arrivedFrom = gap > 0 && chainPaths[gap - 1].length >= 2 ? chainPaths[gap - 1][chainPaths[gap - 1].length - 2] : -1;
    const departsTo = gap + 1 < nGaps && chainPaths[gap + 1].length >= 2 ? chainPaths[gap + 1][1] : -1;
    const treeP = dijkstra(g, P, radius, minRuns, othersUsed, arrivedFrom);
    const treeQ = P === Q ? treeP : dijkstra(g, Q, radius, minRuns, othersUsed, -1, departsTo);
    const other = fixedTotal - legLen[gap];
    const lo = targetM * (1 - tol) - other;
    const hi = targetM * (1 + tol) - other;
    if (hi < legLen[gap]) continue;
    const gapT = (lo + hi) / 2;
    const loopGap = P === Q;

    const share = gapT / (free + 1);
    const minA = loopGap ? 0.45 * share : 0.03 * gapT;
    const maxA = loopGap ? Math.min(0.5 * gapT, 1.35 * share) : 0.7 * gapT;
    const minLeg = Math.min(0.1 * gapT, 0.45 * share);
    const aPool: number[] = [];
    treeP.real.forEach((m, node) => { if (m >= minA && m <= maxA && treeQ.real.has(node)) aPool.push(node); });
    if (aPool.length === 0) continue;
    shuffle(aPool, rnd);

    // Join the fixed legs around this gap's generated path into one route.
    const assemble = (gapNodes: number[]): number[] => {
      let all: number[] = [];
      for (let i = 0; i < nGaps; i++) {
        const leg = i === gap ? gapNodes : chainPaths[i];
        all = all.concat(i === 0 ? leg : leg.slice(1));
      }
      return all;
    };

    const finish = (segments: number[][], lastWp: number, lastTree: Tree, acc: number, remaining: number, used: Set<number>) => {
      if (Date.now() > gapDeadline) return;
      if (remaining === 0) {
        const endLeg = treeQ.real.get(lastWp);
        if (endLeg === undefined || acc + endLeg < lo || acc + endLeg > hi) return;
        const gapNodes = segments.reduce<number[]>((all, seg, i) => all.concat(i === 0 ? seg : seg.slice(1)), [])
          .concat(pathTo(treeQ, lastWp).reverse().slice(1));
        const sc = evaluate(g, assemble(gapNodes), targetM, tol, isLoop, opts.stats);
        if (sc) found.push(sc);
        return;
      }
      if (remaining === 1) {
        const fits: number[] = [];
        lastTree.real.forEach((m, b) => {
          const endB = treeQ.real.get(b);
          if (endB === undefined || m < minLeg) return;
          if (acc + m + endB >= lo && acc + m + endB <= hi) fits.push(b);
        });
        shuffle(fits, rnd);
        for (const b of fits.slice(0, 16)) {
          finish([...segments, pathTo(lastTree, b)], b, lastTree, acc + lastTree.real.get(b)!, 0, used);
        }
        return;
      }
      const next: number[] = [];
      lastTree.real.forEach((m, c) => {
        const endC = treeQ.real.get(c);
        if (endC === undefined || m < minLeg) return;
        if (acc + m + endC <= hi) next.push(c);
      });
      shuffle(next, rnd);
      for (const c of next.slice(0, 2)) {
        if (Date.now() > gapDeadline) return;
        const leg = pathTo(lastTree, c);
        const used2 = new Set<number>();
        used.forEach(k => used2.add(k));
        addPathEdges(used2, leg);
        const tree = dijkstra(g, c, targetM * 0.8, minRuns, used2, leg.length >= 2 ? leg[leg.length - 2] : -1);
        finish([...segments, leg], c, tree, acc + lastTree.real.get(c)!, remaining - 1, used2);
      }
    };

    for (const a of aPool.slice(0, 400)) {
      if (Date.now() > gapDeadline) break;
      const accA = treeP.real.get(a)!;
      const seg0 = pathTo(treeP, a);
      const usedA = new Set<number>();
      othersUsed.forEach(k => usedA.add(k));
      addPathEdges(usedA, seg0);
      if (free === 1) finish([seg0], a, treeP, accA, 0, usedA);
      else finish([seg0], a, dijkstra(g, a, targetM * 0.8, minRuns, usedA, seg0.length >= 2 ? seg0[seg0.length - 2] : -1), accA, free - 1, usedA);
    }
  }

  found.sort((x, y) => x.score - y.score);
  const picked: Scored[] = [];
  for (const f of found) {
    if (picked.every(p => jaccard(p.edges, f.edges) < 0.5)) picked.push(f);
    if (picked.length >= count) break;
  }
  return picked.map(p => p.cand);
}

// Index of the first leg of start → via… → end with no path at this
// `minRuns`, or -1 when the whole chain is connected.
export function firstUnreachableLeg(g: RouteGraph, start: number, via: number[], end: number, minRuns: number): number {
  const fixed = [start, ...via, end];
  for (let i = 0; i < fixed.length - 1; i++) {
    if (!dijkstra(g, fixed[i], Infinity, minRuns).real.has(fixed[i + 1])) return i;
  }
  return -1;
}

// Share of a route (0–1) that runs along ground at least `minRuns` of your
// runs covered, within ~25 m. Used to rate routes that weren't built from
// your GPS graph.
interface FamiliarIndex { kx: number; cells: Set<string>; minRuns: number }
const supportedCells = new WeakMap<RouteGraph, FamiliarIndex>();

export function familiarityOf(g: RouteGraph, points: [number, number][], minRuns: number): number {
  let idx = supportedCells.get(g);
  if (!idx || idx.minRuns !== minRuns) {
    const lat0 = g.lat[0] ?? 0;
    const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
    const cells = new Set<string>();
    for (let i = 0; i < g.lat.length; i++) {
      if (!g.adj[i].some(e => e.cnt >= minRuns)) continue;
      cells.add(`${Math.floor((g.lng[i] * kx) / 25)},${Math.floor((g.lat[i] * 110540) / 25)}`);
    }
    idx = { kx, cells, minRuns };
    supportedCells.set(g, idx);
  }
  const samples = resample(points, 20);
  if (samples.length === 0) return 0;
  let hits = 0;
  for (const p of samples) {
    const cx = Math.floor((p[1] * idx.kx) / 25);
    const cy = Math.floor((p[0] * 110540) / 25);
    let near = false;
    for (let dx = -1; dx <= 1 && !near; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (idx.cells.has(`${cx + dx},${cy + dy}`)) { near = true; break; }
    }
    if (near) hits++;
  }
  return hits / samples.length;
}
