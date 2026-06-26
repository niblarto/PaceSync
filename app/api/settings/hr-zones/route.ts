import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { buildRunningZones, getDefaultZones } from "@/lib/bpm-zones";
import type { HRZone } from "@/types";
import fs from "fs";
import path from "path";

const ZONES_FILE = path.join(process.cwd(), "hr-zones.json");

interface SavedData {
  zones: HRZone[];
  maxHR?: number;
  restingHR?: number;
}

function loadSaved(): SavedData | null {
  try {
    const data = JSON.parse(fs.readFileSync(ZONES_FILE, "utf-8")) as SavedData;
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
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { zones: HRZone[]; maxHR?: number; restingHR?: number };
  const { zones, maxHR, restingHR } = body;

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

  fs.writeFileSync(ZONES_FILE, JSON.stringify(data), "utf-8");
  return NextResponse.json({ ok: true });
}
