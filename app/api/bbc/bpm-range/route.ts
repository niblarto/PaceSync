import { NextRequest, NextResponse } from "next/server";
import { libraryBpmRange, isWithinLibraryBpmRange } from "@/lib/bbc-bpm-filter";

export async function GET() {
  return NextResponse.json(libraryBpmRange());
}

// Given { tempos: Record<id, number> }, returns { inRange: Record<id, boolean> }
// — keeps the doubling convention (see lib/bbc-bpm-filter.ts) in one place
// rather than duplicating it client-side.
export async function POST(req: NextRequest) {
  const body = await req.json() as { tempos?: Record<string, number> };
  const tempos = body.tempos ?? {};
  const inRange: Record<string, boolean> = {};
  for (const [id, tempo] of Object.entries(tempos)) {
    inRange[id] = isWithinLibraryBpmRange(tempo);
  }
  return NextResponse.json({ inRange });
}
