import { getDb } from "@/lib/db";

// Routes made in the Route Finder and kept for later. A saved route can be
// pinned to a scheduled Runna run like a past activity can: the pin stores the
// id "saved:<id>" in place of a Garmin activity id, and /api/garmin/route/[id]
// serves the saved geometry for those ids.

const MAX_POINTS = 700;
const M_PER_MI = 1609.344;

export const SAVED_PREFIX = "saved:";

export interface SavedRoute {
  id: string;
  name: string;
  distanceMi: number;
  createdAt: string;
  /** "gpx" = imported from a GPX file. */
  source: "runs" | "streets" | "gpx";
  snapped: boolean;
  isLoop: boolean;
}

export type LatLng = [number, number];

interface Row {
  id: string;
  name: string;
  distance_mi: number;
  created_at: string;
  source: string;
  snapped: number;
  is_loop: number;
  points_json?: string;
}

function toSaved(r: Row): SavedRoute {
  return {
    id: r.id, name: r.name, distanceMi: r.distance_mi, createdAt: r.created_at,
    source: r.source === "streets" ? "streets" : r.source === "gpx" ? "gpx" : "runs", snapped: !!r.snapped, isLoop: !!r.is_loop,
  };
}

export function listSavedRoutes(): SavedRoute[] {
  const rows = getDb().prepare(
    "SELECT id, name, distance_mi, created_at, source, snapped, is_loop FROM saved_routes ORDER BY created_at DESC",
  ).all() as Row[];
  return rows.map(toSaved);
}

// Evenly thinned to MAX_POINTS, always keeping the first and last point.
function thin(points: LatLng[]): LatLng[] {
  if (points.length <= MAX_POINTS) return points;
  const step = (points.length - 1) / (MAX_POINTS - 1);
  const out: LatLng[] = [];
  for (let i = 0; i < MAX_POINTS - 1; i++) out.push(points[Math.round(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

export function saveRoute(r: {
  name: string; distanceMi: number; points: LatLng[]; source: "runs" | "streets" | "gpx"; snapped: boolean; isLoop: boolean;
}): SavedRoute {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const createdAt = new Date().toISOString();
  getDb().prepare(
    "INSERT INTO saved_routes (id, name, distance_mi, created_at, source, snapped, is_loop, points_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, r.name, r.distanceMi, createdAt, r.source, r.snapped ? 1 : 0, r.isLoop ? 1 : 0, JSON.stringify(thin(r.points)));
  return { id, name: r.name, distanceMi: r.distanceMi, createdAt, source: r.source, snapped: r.snapped, isLoop: r.isLoop };
}

export function renameRoute(id: string, name: string): void {
  getDb().prepare("UPDATE saved_routes SET name = ? WHERE id = ?").run(name, id);
}

export function deleteRoute(id: string): void {
  getDb().prepare("DELETE FROM saved_routes WHERE id = ?").run(id);
}

export function getSavedRoutePoints(id: string): { name: string; distanceMi: number; points: LatLng[] } | null {
  const row = getDb().prepare("SELECT * FROM saved_routes WHERE id = ?").get(id) as Row | undefined;
  if (!row || !row.points_json) return null;
  return { name: row.name, distanceMi: row.distance_mi, points: JSON.parse(row.points_json) as LatLng[] };
}

// The shape /api/garmin/route/[id] returns for a GarminDB activity, built from
// a saved route: points are [lat, lng, speed, elapsedSec, cumulativeMi] and a
// saved route has no pace or timing of its own, so speed and elapsed are null.
export function savedRouteAsActivityRoute(id: string) {
  const r = getSavedRoutePoints(id);
  if (!r) return null;
  const toRad = (d: number) => (d * Math.PI) / 180;
  let cum = 0;
  const points = r.points.map((p, i) => {
    if (i > 0) {
      const q = r.points[i - 1];
      const dLat = toRad(p[0] - q[0]), dLng = toRad(p[1] - q[1]);
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(q[0])) * Math.cos(toRad(p[0])) * Math.sin(dLng / 2) ** 2;
      cum += (6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))) / M_PER_MI;
    }
    return [p[0], p[1], null, null, cum] as [number, number, null, null, number];
  });
  return { name: r.name, distance: r.distanceMi, elapsedTime: null, points };
}
