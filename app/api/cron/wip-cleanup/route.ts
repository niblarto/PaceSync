import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getFreshToken } from "@/lib/tokenStore";
import { getSpotifyBlockedUntil } from "@/lib/spotify-rate-limit";
import { clearAllWipPlaylists } from "@/lib/wip-playlist";

// 04:00 daily: unfollows any "_WIP" playlist left behind by a mix that was never closed or saved.
// Same X-Cron-Secret-or-session auth as the other /api/cron/* routes.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const hasCronSecret = !!process.env.CRON_SECRET && req.headers.get("X-Cron-Secret") === process.env.CRON_SECRET;
  if (!hasCronSecret) {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const blocked = await getSpotifyBlockedUntil("main");
    if (blocked) {
      console.log(`[cron/wip-cleanup] Spotify is rate-limiting until ${blocked} - skipped`);
      return NextResponse.json({ ok: true, skipped: true, until: blocked });
    }
    const token = await getFreshToken();
    if (!token.ok) return NextResponse.json({ ok: false, error: `No Spotify token (${token.reason})` }, { status: 502 });
    const r = await clearAllWipPlaylists(token.token);
    console.log(`[cron/wip-cleanup] found ${r.found}, deleted ${r.deleted}${r.failed.length ? `, failed: ${r.failed.join(", ")}` : ""}`);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn("[cron/wip-cleanup] failed:", error);
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
