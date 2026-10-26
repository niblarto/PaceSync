import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { clearCrawledArtists, loadCrawledArtists } from "@/lib/crawled-artists";

// The Song Crawler's log of artists it has crawled, newest first.
//   GET    -> { artists: [{ id, name, at, added, crawls }] }
//   DELETE -> clear the log
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ artists: loadCrawledArtists() });
}

export async function DELETE(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  clearCrawledArtists();
  return NextResponse.json({ ok: true });
}
