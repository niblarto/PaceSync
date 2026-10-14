import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { syncLibraryWithSpotify } from "@/lib/spotify-library-sync";
import { cronNotify } from "@/lib/cron-notify";

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
    await cronNotify(`Library ↔ Spotify sync failed: ${result.error}`, { title: "❌ Library sync failed", tags: "x", type: "sync-error", priority: "high" });
  } else if ("skippedRemovals" in result && result.skippedRemovals) {
    await cronNotify(
      `${result.skippedRemovals} tracks deleted from the library are still on Spotify — over the per-run safety limit, so none were removed. Check before removing them by hand.`,
      { title: "⚠ Library sync needs a look", tags: "warning", type: "sync-error" },
    );
  } else {
    const changes = result.addedToSpotify + result.importedToLibrary + result.removedFromSpotify;
    await cronNotify(
      changes === 0
        ? `Library and Spotify already match (${result.libraryCount} tracks).`
        : `+${result.addedToSpotify} added to Spotify, +${result.importedToLibrary} imported into the library, −${result.removedFromSpotify} removed from Spotify.`,
      { title: "✅ Library sync done", tags: "white_check_mark", type: "library-sync", priority: changes === 0 ? "low" : "default" },
    );
  }

  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
