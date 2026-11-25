import { getDb } from "@/lib/db";
import type { RouteGraph } from "@/lib/route-graph";

// Routes are stitched from GPS points, and where a canal or river runs between two paths, points on opposite banks (or a
// node averaged into the middle of the water) can end up joined by a link straight across it. This removes any link that
// crosses water unless a bridge is right there. Water and bridges come from OpenStreetMap (Overpass), one ~10 km tile at a
// time, kept for 90 days. Only tiles near your home are checked, and only the tile boundaries and no run data go out.

const TILE_LAT = 0.1, TILE_LNG = 0.15;
const NEAR_HOME_M = 20_000, MAX_TILES = 16;
const TTL_MS = 90 * 86_400_000;
const BRIDGE_REACH_M = 30;     // a crossing this close to a bridge is the bridge
const INSIDE_WATER_M = 8;      // a link with this much of itself inside a lake / canal outline is a water crossing
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

type Pt = [number, number]; // lat, lng
interface Tile { lines: Pt[][]; polys: Pt[][]; bridges: Pt[][] }

const tileKey = (la: number, lo: number) => `${la},${lo}`;
const tileOf = (lat: number, lng: number): [number, number] => [Math.floor(lat / TILE_LAT), Math.floor(lng / TILE_LNG)];

async function fetchTile(ti: number, tj: number): Promise<Tile | null> {
  const s = ti * TILE_LAT - 0.002, n = (ti + 1) * TILE_LAT + 0.002, w = tj * TILE_LNG - 0.003, e = (tj + 1) * TILE_LNG + 0.003;
  const bbox = `${s},${w},${n},${e}`;
  const query = `[out:json][timeout:60];(`
    + `way["waterway"~"^(canal|river)$"]["tunnel"!~"."]["culvert"!~"."](${bbox});`
    + `way["natural"="water"]["tunnel"!~"."](${bbox});way["waterway"="riverbank"](${bbox});`
    + `way["highway"]["bridge"]["bridge"!="no"](${bbox});way["railway"]["bridge"]["bridge"!="no"](${bbox});`
    + `);out geom tags;`;
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "PaceSync-RouteFinder/1.0 (personal use)", Accept: "*/*" },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(70_000),
      });
      if (!res.ok) continue;
      const data = await res.json() as { elements?: { type: string; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[] }[] };
      const tile: Tile = { lines: [], polys: [], bridges: [] };
      for (const el of data.elements ?? []) {
        if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
        const pts = el.geometry.map(g => [Math.round(g.lat * 1e6) / 1e6, Math.round(g.lon * 1e6) / 1e6] as Pt);
        const t = el.tags ?? {};
        if (t.bridge && t.bridge !== "no" && (t.highway || t.railway)) tile.bridges.push(pts);
        else if (t.natural === "water" || t.waterway === "riverbank") { if (pts.length >= 4) tile.polys.push(pts); }
        else if (t.waterway === "canal" || t.waterway === "river") tile.lines.push(pts);
      }
      return tile;
    } catch { continue; }
  }
  return null;
}

async function loadTile(ti: number, tj: number): Promise<Tile | null> {
  const db = getDb();
  const key = `route_water:v1:${tileKey(ti, tj)}`;
  const row = db.prepare("SELECT value_json FROM kv_config WHERE key = ?").get(key) as { value_json: string } | undefined;
  if (row) {
    try {
      const c = JSON.parse(row.value_json) as { at: number; tile: Tile };
      if (Date.now() - c.at < TTL_MS) return c.tile;
    } catch { /* refetch */ }
  }
  const tile = await fetchTile(ti, tj);
  if (tile) db.prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(key, JSON.stringify({ at: Date.now(), tile }));
  return tile;
}

// ── geometry (local metres) ────────────────────────────────────────────────────────────────────────────────────────
type Seg = [number, number, number, number];
const CELL = 100;

function segsIntersect(a: Seg, b: Seg): boolean {
  const d = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d1 = d(b[0], b[1], b[2], b[3], a[0], a[1]), d2 = d(b[0], b[1], b[2], b[3], a[2], a[3]);
  const d3 = d(a[0], a[1], a[2], a[3], b[0], b[1]), d4 = d(a[0], a[1], a[2], a[3], b[2], b[3]);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function distToSeg(px: number, py: number, s: Seg): number {
  const dx = s[2] - s[0], dy = s[3] - s[1], l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - s[0]) * dx + (py - s[1]) * dy) / l2));
  return Math.hypot(px - (s[0] + t * dx), py - (s[1] + t * dy));
}
function pointInPoly(x: number, y: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

class SegGrid {
  private cells = new Map<string, Seg[]>();
  add(s: Seg) {
    const x0 = Math.floor(Math.min(s[0], s[2]) / CELL), x1 = Math.floor(Math.max(s[0], s[2]) / CELL);
    const y0 = Math.floor(Math.min(s[1], s[3]) / CELL), y1 = Math.floor(Math.max(s[1], s[3]) / CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = `${x},${y}`; const a = this.cells.get(k); if (a) a.push(s); else this.cells.set(k, [s]); }
  }
  near(x0: number, y0: number, x1: number, y1: number, pad = 0): Seg[] {
    const out: Seg[] = [];
    const seen = new Set<Seg>();
    for (let x = Math.floor((Math.min(x0, x1) - pad) / CELL); x <= Math.floor((Math.max(x0, x1) + pad) / CELL); x++) {
      for (let y = Math.floor((Math.min(y0, y1) - pad) / CELL); y <= Math.floor((Math.max(y0, y1) + pad) / CELL); y++) {
        const a = this.cells.get(`${x},${y}`);
        if (a) for (const s of a) if (!seen.has(s)) { seen.add(s); out.push(s); }
      }
    }
    return out;
  }
}

// Removes the links that cross water (no bridge nearby) in the graph's tiles near `home`. Idempotent per graph and tile;
// returns how many links were removed in this call, and a note if some tiles couldn't be fetched.
export async function applyWaterFilter(g: RouteGraph & { waterTiles?: string[] }): Promise<{ removed: number; note?: string }> {
  if (g.lat.length === 0) return { removed: 0 };
  const hLat = g.lat[g.home], hLng = g.lng[g.home];
  const mPerLng = Math.cos((hLat * Math.PI) / 180) * 111320;
  const X = (lng: number) => (lng - hLng) * mPerLng, Y = (lat: number) => (lat - hLat) * 110540;
  const done = new Set(g.waterTiles ?? []);

  // Tiles that hold nodes within reach of home.
  const want = new Map<string, [number, number]>();
  for (let i = 0; i < g.lat.length; i++) {
    if (g.adj[i].length === 0) continue;
    if (Math.hypot(X(g.lng[i]), Y(g.lat[i])) > NEAR_HOME_M) continue;
    const [ti, tj] = tileOf(g.lat[i], g.lng[i]);
    const k = tileKey(ti, tj);
    if (!done.has(k) && !want.has(k)) want.set(k, [ti, tj]);
  }
  const todo = Array.from(want.entries()).slice(0, MAX_TILES);
  if (todo.length === 0) return { removed: 0 };

  const tiles = new Map<string, Tile>();
  let failed = 0;
  for (let i = 0; i < todo.length; i += 3) {
    await Promise.all(todo.slice(i, i + 3).map(async ([k, [ti, tj]]) => {
      const t = await loadTile(ti, tj).catch(() => null);
      if (t) tiles.set(k, t); else failed++;
    }));
  }
  if (tiles.size === 0) return { removed: 0, note: failed ? "Couldn't check for canals and rivers (OpenStreetMap didn't answer)." : undefined };

  const water = new SegGrid(), bridges = new SegGrid();
  const polys: { ring: number[][]; x0: number; y0: number; x1: number; y1: number }[] = [];
  const toSegs = (pts: Pt[], into: SegGrid) => { for (let i = 1; i < pts.length; i++) into.add([X(pts[i - 1][1]), Y(pts[i - 1][0]), X(pts[i][1]), Y(pts[i][0])]); };
  tiles.forEach(t => {
    t.lines.forEach(l => toSegs(l, water));
    t.bridges.forEach(b => toSegs(b, bridges));
    t.polys.forEach(p => {
      const ring = p.map(q => [X(q[1]), Y(q[0])]);
      toSegs(p, water);
      polys.push({ ring, x0: Math.min(...ring.map(r => r[0])), y0: Math.min(...ring.map(r => r[1])), x1: Math.max(...ring.map(r => r[0])), y1: Math.max(...ring.map(r => r[1])) });
    });
  });
  const inWater = (x: number, y: number) => polys.some(p => x >= p.x0 && x <= p.x1 && y >= p.y0 && y <= p.y1 && pointInPoly(x, y, p.ring));

  const overWater = (ax: number, ay: number, bx: number, by: number): boolean => {
    const seg: Seg = [ax, ay, bx, by];
    let cross: [number, number] | null = null;
    for (const w of water.near(ax, ay, bx, by)) {
      if (segsIntersect(seg, w)) { cross = [(ax + bx) / 2, (ay + by) / 2]; break; }
    }
    if (!cross) {
      // No outline crossed: is a good part of the link inside a lake / canal outline?
      const len = Math.hypot(bx - ax, by - ay), n = Math.max(2, Math.ceil(len / 2));
      let inside = 0;
      for (let i = 0; i <= n; i++) if (inWater(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n)) inside++;
      if ((inside * len) / n < INSIDE_WATER_M) return false;
      cross = [(ax + bx) / 2, (ay + by) / 2];
    }
    // Over a bridge, not over the water.
    for (const b of bridges.near(cross[0], cross[1], cross[0], cross[1], BRIDGE_REACH_M)) if (distToSeg(cross[0], cross[1], b) <= BRIDGE_REACH_M) return false;
    return true;
  };

  const doomed = new Set<string>();
  for (let a = 0; a < g.adj.length; a++) {
    const ta = tileKey(...tileOf(g.lat[a], g.lng[a]));
    if (!tiles.has(ta)) continue;
    for (const e of g.adj[a]) {
      if (e.to < a) continue;
      if (overWater(X(g.lng[a]), Y(g.lat[a]), X(g.lng[e.to]), Y(g.lat[e.to]))) doomed.add(`${a}_${e.to}`);
    }
  }
  if (doomed.size > 0) {
    for (let a = 0; a < g.adj.length; a++) g.adj[a] = g.adj[a].filter(e => !doomed.has(a < e.to ? `${a}_${e.to}` : `${e.to}_${a}`));
  }
  g.waterTiles = Array.from(new Set([...(g.waterTiles ?? []), ...Array.from(tiles.keys())]));
  return { removed: doomed.size, note: failed ? "Some areas couldn't be checked for canals and rivers (OpenStreetMap was busy); they'll be checked next time." : undefined };
}
