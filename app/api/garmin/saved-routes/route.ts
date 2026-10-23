import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { deleteRoute, listSavedRoutes, renameRoute, saveRoute, type LatLng } from "@/lib/saved-routes";

export const dynamic = "force-dynamic";

// Routes saved from the Route Finder. GET lists them (no geometry — that's
// served by /api/garmin/route/saved:<id>); POST saves one; PATCH renames;
// DELETE removes.

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ routes: listSavedRoutes() });
}

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({})) as {
    name?: string; distanceMi?: number; points?: unknown; source?: string; snapped?: boolean; isLoop?: boolean;
  };
  const points = Array.isArray(b.points)
    ? (b.points as unknown[]).filter((p): p is LatLng => Array.isArray(p) && p.length >= 2 && typeof p[0] === "number" && typeof p[1] === "number")
        .map(p => [p[0], p[1]] as LatLng)
    : [];
  if (points.length < 2 || typeof b.distanceMi !== "number" || !(b.distanceMi > 0)) {
    return NextResponse.json({ error: "points and distanceMi required" }, { status: 400 });
  }
  const route = saveRoute({
    name: (b.name ?? "").trim().slice(0, 80) || `Route ${b.distanceMi.toFixed(1)} mi`,
    distanceMi: b.distanceMi,
    points,
    source: b.source === "streets" ? "streets" : b.source === "gpx" ? "gpx" : "runs",
    snapped: !!b.snapped,
    isLoop: b.isLoop !== false,
  });
  return NextResponse.json({ route });
}

export async function PATCH(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, name } = await req.json().catch(() => ({})) as { id?: string; name?: string };
  if (!id || !name?.trim()) return NextResponse.json({ error: "id and name required" }, { status: 400 });
  renameRoute(id, name.trim().slice(0, 80));
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await req.json().catch(() => ({})) as { id?: string };
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  deleteRoute(id);
  return NextResponse.json({ ok: true });
}
