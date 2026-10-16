import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { getCrawl, removeCrawlAddedTrack, requestStopCrawl, setCrawlReviewLimit, startCrawl, type CrawlParams } from "@/lib/song-crawler";
import { deleteFromLibraryServer } from "@/lib/library-delete";

// Song Crawler control (Settings > Tracklist). The crawl itself is a
// server-side background job (lib/song-crawler.ts) that keeps running with
// no browser attached:
//   POST   { artist, bpm | bpmMin+bpmMax, maxArtists, sources: { artist, radio, related } } -> start
//   GET    ?since=<seq>  -> current/last crawl status + log lines from <seq>
//   DELETE               -> stop (finishes the current track, then the
//                           post-crawl fill-in, all logged)
//   PATCH  { removeAdded: uri, reason?: "deleted" | "accepted" } -> drop a
//                           song from the crawl's added list (deleted from
//                           the library, or accepted and kept). With
//                           deleteFromLibrary the server also does the
//                           delete itself (the Android app has no browser
//                           Spotify token; the web page deletes client-side).
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

export async function PATCH(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { removeAdded, reason, deleteFromLibrary, reviewLimit } = await req.json().catch(() => ({})) as { removeAdded?: string | string[]; reason?: string; deleteFromLibrary?: boolean; reviewLimit?: number | null };
  // { reviewLimit } alone: change the running crawl's review limit.
  if (reviewLimit !== undefined && removeAdded === undefined) {
    return NextResponse.json({ ok: setCrawlReviewLimit(reviewLimit) });
  }
  // One uri, or several (multi-select Accept / Delete).
  const uris = (Array.isArray(removeAdded) ? removeAdded : removeAdded ? [removeAdded] : []).filter(u => typeof u === "string" && u);
  if (uris.length === 0) return NextResponse.json({ error: "removeAdded (uri or uri list) required" }, { status: 400 });
  const kind: "accepted" | "removed" | "deleted" = reason === "accepted" ? "accepted" : reason === "removed" ? "removed" : "deleted";
  let removed = 0;
  for (const uri of uris) {
    if (deleteFromLibrary && kind !== "accepted") await deleteFromLibraryServer(uri, kind === "removed");
    if (removeCrawlAddedTrack(uri, kind)) removed++;
  }
  return NextResponse.json({ ok: removed > 0, removed });
}
