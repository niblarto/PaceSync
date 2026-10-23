import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDb } from "@/lib/db";

// The saved "home" the Route Finder map opens on and starts routes from.

const KEY = "route_home";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let home: { lat: number; lng: number } | null = null;
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    if (row) home = JSON.parse(row.value_json);
  } catch {}
  return NextResponse.json({ home });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { lat?: number; lng?: number };
  if (typeof body.lat !== "number" || typeof body.lng !== "number" || isNaN(body.lat) || isNaN(body.lng)) {
    return NextResponse.json({ error: "lat and lng are required" }, { status: 400 });
  }
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify({ lat: body.lat, lng: body.lng }));
  return NextResponse.json({ ok: true });
}
