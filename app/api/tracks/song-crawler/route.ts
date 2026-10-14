import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { getCrawl, requestStopCrawl, startCrawl, type CrawlParams } from "@/lib/song-crawler";

// Song Crawler control (Settings > Tracklist). The crawl itself is a
// server-side background job (lib/song-crawler.ts) that keeps running with
// no browser attached:
//   POST   { artist, bpm | bpmMin+bpmMax, maxArtists, sources: { artist, radio, related } } -> start
//   GET    ?since=<seq>  -> current/last crawl status + log lines from <seq>
//   DELETE               -> stop (finishes the current track, then the
//                           post-crawl fill-in, all logged)
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const params = await req.json().catch(() => null) as CrawlParams | null;
  if (!params) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const result = startCrawl(params);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ ok: true, id: result.id });
}

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const since = Math.max(0, parseInt(req.nextUrl.searchParams.get("since") ?? "0", 10) || 0);
  return NextResponse.json(getCrawl(since));
}

export async function DELETE(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ok = requestStopCrawl();
  return NextResponse.json({ ok }, { status: ok ? 200 : 409 });
}
