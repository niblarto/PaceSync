import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadGarminConfig, saveGarminConfig, deleteGarminConfig } from "@/lib/garmin-config";
import type { GarminConfig } from "@/lib/garmin-config";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const config = loadGarminConfig();
  return NextResponse.json({ config, configured: config !== null });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as Partial<GarminConfig>;
  if (!body.dbPath) {
    return NextResponse.json({ error: "dbPath is required" }, { status: 400 });
  }

  saveGarminConfig({ dbPath: body.dbPath });
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  deleteGarminConfig();
  return NextResponse.json({ ok: true });
}
