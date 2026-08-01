import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDb } from "@/lib/db";

export interface BbcProgramme {
  pid: string;
  name: string;
  synopsis?: string;
}

const KEY = "bbc_programmes";

const DEFAULTS: BbcProgramme[] = [
  { pid: "m001j52w", name: "6 Music Playlist", synopsis: "" },
  { pid: "m0012v02", name: "6 Music's Indie Forever", synopsis: "" },
  { pid: "m002xsbn", name: "Lauren Laverne", synopsis: "" },
];

function load(): BbcProgramme[] {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    if (row) {
      const data = JSON.parse(row.value_json) as BbcProgramme[];
      if (Array.isArray(data) && data.length > 0) return data;
    }
  } catch {}
  return DEFAULTS;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ programmes: load() });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { programmes: BbcProgramme[] };
  if (!Array.isArray(body.programmes)) {
    return NextResponse.json({ error: "Invalid data" }, { status: 400 });
  }

  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(body.programmes));
  return NextResponse.json({ ok: true });
}
