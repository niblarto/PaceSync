import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import fs from "fs";
import path from "path";

export interface BbcProgramme {
  pid: string;
  name: string;
  synopsis?: string;
}

const FILE = path.join(process.cwd(), "bbc-programmes.json");

const DEFAULTS: BbcProgramme[] = [
  { pid: "m001j52w", name: "6 Music Playlist", synopsis: "" },
  { pid: "m0012v02", name: "6 Music's Indie Forever", synopsis: "" },
  { pid: "m002xsbn", name: "Lauren Laverne", synopsis: "" },
];

function load(): BbcProgramme[] {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf-8")) as BbcProgramme[];
    if (Array.isArray(data) && data.length > 0) return data;
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

  fs.writeFileSync(FILE, JSON.stringify(body.programmes), "utf-8");
  return NextResponse.json({ ok: true });
}
