import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { syncLibraryWithSpotify } from "@/lib/spotify-library-sync";
import { sendPush } from "@/lib/push";

// Daily library <-> Spotify playlist sync ("librarySync" cron job). Same
// X-Cron-Secret-or-session auth as the other /api/cron/* routes.
export async function POST(req: NextRequest) {
  const hasCronSecret = !!process.env.CRON_SECRET && req.headers.get("X-Cron-Secret") === process.env.CRON_SECRET;
  if (!hasCronSecret) {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await syncLibraryWithSpotify().catch((e: unknown) => ({
    ok: false as const, error: e instanceof Error ? e.message : String(e),
    libraryCount: 0, spotifyCount: 0, addedToSpotify: 0, importedToLibrary: 0, removedFromSpotify: 0,
  }));

  console.log(
    `[library-sync] ${result.ok ? "ok" : `FAILED: ${result.error}`} — library ${result.libraryCount}, spotify ${result.spotifyCount}; ` +
    `+${result.addedToSpotify} to Spotify, +${result.importedToLibrary} to library, -${result.removedFromSpotify} from Spotify` +
    ("skippedRemovals" in result && result.skippedRemovals ? `; skipped ${result.skippedRemovals} removals (over safety limit)` : ""),
  );

  if (!result.ok) {
    await sendPush(`Library ↔ Spotify sync failed: ${result.error}`, { title: "Library sync failed", type: "sync-error", priority: "high" });
  } else if ("skippedRemovals" in result && result.skippedRemovals) {
    await sendPush(
      `${result.skippedRemovals} tracks deleted from the library are still on Spotify — over the per-run safety limit, so none were removed. Check before removing them by hand.`,
      { title: "Library sync needs a look", type: "sync-error" },
    );
  }

  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
