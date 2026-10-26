import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { clearCrawlQueue, enqueueCrawl, removeQueuedCrawl, requestPauseCrawl, resumeCrawl, getCrawl, getCrawlQueue, getReviewPlaylistUri, removeCrawlAddedTrack, requestStopCrawl, setCrawlReviewLimit, startCrawl, type CrawlParams } from "@/lib/song-crawler";
import { deleteFromLibraryServer } from "@/lib/library-delete";
import { ensureSpotifyRemovalsStarted } from "@/lib/spotify-removals";

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
  const params = await req.json().catch(() => null) as (CrawlParams & { enqueue?: boolean }) | null;
  if (!params) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  // enqueue (right-click > Lookup): start now if nothing is running, else join the queue.
  if (params.enqueue) {
    const { enqueue: _enqueue, ...crawl } = params;
    void _enqueue;
    const q = enqueueCrawl(crawl);
    if (!q.ok) return NextResponse.json({ error: q.error }, { status: 400 });
    return NextResponse.json({ ok: true, started: q.started, queued: q.queued });
  }
  const result = startCrawl(params);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ ok: true, id: result.id });
}

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  ensureSpotifyRemovalsStarted(); // pick up any deletes still waiting for Spotify after a restart
  const since = Math.max(0, parseInt(req.nextUrl.searchParams.get("since") ?? "0", 10) || 0);
  // reviewPlaylist: the "PaceSync review" Spotify playlist (null until it exists and is
  // synced), so the clients can play the review list as a playlist.
  // queue: artists waiting for their own crawl, in order.
  return NextResponse.json({ ...getCrawl(since), reviewPlaylist: getReviewPlaylistUri(), queue: getCrawlQueue() });
}

export async function DELETE(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ok = requestStopCrawl();
  return NextResponse.json({ ok }, { status: ok ? 200 : 409 });
}

export async function PATCH(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { removeAdded, reason, deleteFromLibrary, reviewLimit, clearQueue, removeQueued, crawlControl } = await req.json().catch(() => ({})) as { removeAdded?: string | string[]; reason?: string; deleteFromLibrary?: boolean; reviewLimit?: number | null; clearQueue?: boolean; removeQueued?: string; crawlControl?: "pause" | "resume" };
  // { crawlControl: "pause" | "resume" }: the Pause / Resume button. Resume un-pauses a paused crawl,
  // or carries on an interrupted / stopped one from where it had got to.
  if (crawlControl === "pause") return NextResponse.json({ ok: requestPauseCrawl() });
  if (crawlControl === "resume") {
    const r = resumeCrawl();
    return NextResponse.json(r, { status: r.ok ? 200 : 409 });
  }
  // { clearQueue: true }: forget the artists waiting for a crawl.
  if (clearQueue) return NextResponse.json({ ok: true, cleared: clearCrawlQueue() });
  // { removeQueued: "<artist>" }: take one artist out of the queue.
  if (typeof removeQueued === "string") return NextResponse.json({ ok: removeQueuedCrawl(removeQueued) });
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
