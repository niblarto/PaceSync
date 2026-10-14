import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { findBrokenTracklists } from "@/lib/broken-tracklists";

// Upcoming schedule / Pace Pro tracklists that still contain a track since
// deleted from the library — drives the warning banner and the highlight on
// deleted tracks in a loaded mix (components/useBrokenTracklists.ts).
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const broken = findBrokenTracklists();
    const missingUris = Array.from(new Set(broken.flatMap(b => b.missing.map(m => m.uri))));
    return NextResponse.json({ broken, missingUris });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
