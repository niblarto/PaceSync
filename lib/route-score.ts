import type { LatLng } from "@/lib/ors";

// Route scoring, adapted from RunPaths (https://github.com/rubentalstra/runpaths,
// MIT): how close the length is to the target, how few sharp turns and
// backtracks, optionally fewer traffic lights and more park, plus a bonus for
// ground you've run before. Higher is better, 0–100.

const NEAR_LIGHT_M = 30;
const NEAR_PARK_M = 30;
// The main Overpass server is often at capacity (502/504), so mirrors are tried
// in turn. Only the route's bounding box goes out, never a start/end label.
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const W_DISTANCE = 40;
const W_QUALITY = 30;
const W_LIGHTS = 25;
const MAX_LIGHTS_FOR_PENALTY = 8;
const W_PARKS = 20;
const W_FAMILIAR = 15;

function toXY(p: LatLng, lat0: number): [number, number] {
  return [p[1] * Math.cos((lat0 * Math.PI) / 180) * 111320, p[0] * 110540];
}

// Evenly spaced points every `stepM` along a polyline, so GPS-grid jitter or
// dense street vertices don't dominate the turn counts.
export function resample(points: LatLng[], stepM: number): LatLng[] {
  if (points.length < 2) return points.slice();
  const out: LatLng[] = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = toXY(points[i - 1], points[0][0]);
    const [bx, by] = toXY(points[i], points[0][0]);
    const len = Math.hypot(bx - ax, by - ay);
    if (len === 0) continue;
    let d = stepM - carry;
    while (d <= len) {
      const t = d / len;
      out.push([points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t]);
      d += stepM;
    }
    carry = len - (d - stepM);
  }
  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  if (tail[0] !== last[0] || tail[1] !== last[1]) out.push(last);
  return out;
}

// 0–1: penalises sharp turns and backtracking, measured on a 40 m resample.
export function routeQuality(points: LatLng[]): number {
  const p = resample(points, 40);
  if (p.length < 3) return 1;
  let sharp = 0;
  let back = 0;
  for (let i = 1; i < p.length - 1; i++) {
    const [ax, ay] = toXY(p[i - 1], p[0][0]);
    const [bx, by] = toXY(p[i], p[0][0]);
    const [cx, cy] = toXY(p[i + 1], p[0][0]);
    const b1 = Math.atan2(bx - ax, by - ay);
    const b2 = Math.atan2(cx - bx, cy - by);
    let turn = Math.abs(((b2 - b1) * 180) / Math.PI);
    if (turn > 180) turn = 360 - turn;
    if (turn > 120) sharp += 2;
    else if (turn > 90) sharp += 1;
    if (turn > 150) back += 1;
  }
  const n = p.length - 2;
  let q = 1;
  q -= Math.min(0.5, (sharp / n) * 0.8);
  q -= Math.min(0.3, (back / n) * 1.2);
  return Math.max(0, Math.min(1, q));
}

// Share (0–1) of the route that goes back over ground it already covered
// (further than ~300 m earlier along the route), within ~30 m.
export function retraceShare(points: LatLng[]): number {
  const r = resample(points, 25);
  if (r.length < 2) return 0;
  const cells = new Map<string, number[]>();
  let repeats = 0;
  r.forEach((p, i) => {
    const [x, y] = toXY(p, r[0][0]);
    const cx = Math.floor(x / 30), cy = Math.floor(y / 30);
    let again = false;
    for (let dx = -1; dx <= 1 && !again; dx++) for (let dy = -1; dy <= 1 && !again; dy++) {
      const seen = cells.get(`${cx + dx},${cy + dy}`);
      if (seen && seen.some(j => i - j > 12)) again = true;
    }
    if (again) repeats++;
    const k = `${cx},${cy}`;
    const arr = cells.get(k);
    if (arr) arr.push(i); else cells.set(k, [i]);
  });
  return repeats / r.length;
}

// 4πA/P² of the route in a flat projection: 1 = round, near 0 = long and thin.
export function roundness(points: LatLng[]): number {
  const r = resample(points, 25);
  if (r.length < 3) return 0;
  const xy = r.map(p => toXY(p, r[0][0]));
  let area = 0, perim = 0;
  for (let i = 1; i < xy.length; i++) {
    area += xy[i - 1][0] * xy[i][1] - xy[i][0] * xy[i - 1][1];
    perim += Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
  }
  const first = xy[0], last = xy[xy.length - 1];
  area += last[0] * first[1] - first[0] * last[1];
  perim += Math.hypot(first[0] - last[0], first[1] - last[1]);
  return perim === 0 ? 0 : Math.min(1, (4 * Math.PI * Math.abs(area / 2)) / (perim * perim));
}

// ---- OpenStreetMap traffic lights and parks (Overpass) --------------------

export interface OsmContext { lights: LatLng[]; parks: LatLng[][] }

interface OverpassEl {
  type: string;
  lat?: number;
  lon?: number;
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

// One query for the traffic signals and parks around all the routes. Returns
// null (scoring then ignores lights/parks) if the area is too big or Overpass
// can't be reached.
export async function loadOsmContext(routes: LatLng[][]): Promise<OsmContext | null> {
  let s = 90, w = 180, n = -90, e = -180;
  for (const r of routes) for (const p of r) {
    s = Math.min(s, p[0]); n = Math.max(n, p[0]); w = Math.min(w, p[1]); e = Math.max(e, p[1]);
  }
  if (!isFinite(s) || n - s > 0.4 || e - w > 0.6) return null;
  const m = 0.0008;
  const bbox = `${s - m},${w - m},${n + m},${e + m}`;
  const query = `[out:json][timeout:40];(node["highway"="traffic_signals"](${bbox});way["leisure"="park"](${bbox}););out geom;`;
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "PaceSync-RouteFinder/1.0 (personal use)",
          Accept: "*/*",
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) continue; // at capacity or rejected: try the next mirror
      const data = await res.json() as { elements?: OverpassEl[] };
      const lights: LatLng[] = [];
      const parks: LatLng[][] = [];
      for (const el of data.elements ?? []) {
        if (el.type === "node" && el.lat !== undefined && el.lon !== undefined) lights.push([el.lat, el.lon]);
        else if (el.type === "way" && el.geometry && el.geometry.length >= 3) parks.push(el.geometry.map(g => [g.lat, g.lon] as LatLng));
      }
      return { lights, parks };
    } catch {
      continue;
    }
  }
  return null;
}

function distToSegM(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Traffic signals within 30 m of the route.
export function countLights(points: LatLng[], ctx: OsmContext): number {
  const r = resample(points, 25);
  const xy = r.map(p => toXY(p, r[0]?.[0] ?? 0));
  let count = 0;
  for (const l of ctx.lights) {
    const [lx, ly] = toXY(l, r[0]?.[0] ?? 0);
    for (let i = 1; i < xy.length; i++) {
      if (distToSegM(lx, ly, xy[i - 1][0], xy[i - 1][1], xy[i][0], xy[i][1]) <= NEAR_LIGHT_M) { count++; break; }
    }
  }
  return count;
}

function inRing(px: number, py: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 0–1: share of the route inside or within 30 m of a park.
export function parkAdjacency(points: LatLng[], ctx: OsmContext): number {
  if (ctx.parks.length === 0) return 0;
  const lat0 = points[0]?.[0] ?? 0;
  const rings = ctx.parks.map(ring => ring.map(p => toXY(p, lat0)));
  const samples = resample(points, Math.max(15, 100)); // ~100 m spacing is enough for a share
  let hits = 0;
  for (const s of samples) {
    const [x, y] = toXY(s, lat0);
    let near = false;
    for (const ring of rings) {
      if (inRing(x, y, ring)) { near = true; break; }
      for (let i = 1; i < ring.length; i++) {
        if (distToSegM(x, y, ring[i - 1][0], ring[i - 1][1], ring[i][0], ring[i][1]) <= NEAR_PARK_M) { near = true; break; }
      }
      if (near) break;
    }
    if (near) hits++;
  }
  return hits / Math.max(1, samples.length);
}

export interface ScoreInput {
  distanceM: number;
  targetM: number;
  quality: number;
  /** 0–1 share of the route on ground you've run, when known. */
  familiarity: number | null;
  lights: number | null;
  avoidLights: boolean;
  parks: number | null;
  preferParks: boolean;
}

export function scoreRoute(i: ScoreInput): number {
  const distancePenalty = Math.min(1, (Math.abs(i.distanceM - i.targetM) / Math.max(1, i.targetM)) * 5);
  let score = 100 - W_DISTANCE * distancePenalty - W_QUALITY * (1 - i.quality);
  if (i.avoidLights && i.lights !== null) score -= W_LIGHTS * Math.min(1, i.lights / MAX_LIGHTS_FOR_PENALTY);
  if (i.preferParks && i.parks !== null) score += W_PARKS * i.parks;
  if (i.familiarity !== null) score += W_FAMILIAR * i.familiarity;
  return Math.round(Math.max(0, Math.min(100, score)));
}
