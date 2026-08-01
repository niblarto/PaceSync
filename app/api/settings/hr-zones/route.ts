import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { buildRunningZones, getDefaultZones } from "@/lib/bpm-zones";
import type { HRZone } from "@/types";
import { getDb } from "@/lib/db";

const KEY = "hr_zones";

interface SavedData {
  zones: HRZone[];
  maxHR?: number;
  restingHR?: number;
  lthr?: number;
  source?: "manual" | "lthr" | "garmin" | "strava";
}

function loadSaved(): SavedData | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    if (!row) return null;
    const data = JSON.parse(row.value_json) as SavedData;
    if (Array.isArray(data.zones) && data.zones.length === 5) return data;
  } catch {}
  return null;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const saved = loadSaved();
  const zones = saved ? buildRunningZones(saved.zones) : getDefaultZones();
  return NextResponse.json({
    zones,
    custom: saved !== null,
    maxHR: saved?.maxHR,
    restingHR: saved?.restingHR,
    lthr: saved?.lthr,
    source: saved?.source ?? "manual",
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { zones: HRZone[]; maxHR?: number; restingHR?: number; lthr?: number; source?: "manual" | "lthr" | "garmin" | "strava" };
  const { zones, maxHR, restingHR, lthr, source } = body;

  if (!Array.isArray(zones) || zones.length !== 5) {
    return NextResponse.json({ error: "Expected 5 zones" }, { status: 400 });
  }
  for (const z of zones) {
    if (typeof z.min !== "number" || typeof z.max !== "number" || z.min >= z.max) {
      return NextResponse.json({ error: "Each zone needs min < max" }, { status: 400 });
    }
  }

  const data: SavedData = { zones };
  if (typeof maxHR === "number")     data.maxHR = maxHR;
  if (typeof restingHR === "number") data.restingHR = restingHR;
  if (typeof lthr === "number")      data.lthr = lthr;
  if (source === "manual" || source === "lthr" || source === "garmin" || source === "strava") data.source = source;

  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(data));
  return NextResponse.json({ ok: true });
}
