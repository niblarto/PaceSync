import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { brokenTracklistsMessage, findBrokenTracklists } from "@/lib/broken-tracklists";
import { cronNotify } from "@/lib/cron-notify";

// Daily broken-tracklist check ("brokenCheck" cron job, 08:00 by default):
// notifies (ntfy + Android app) when any upcoming schedule or Pace Pro
// tracklist still contains a track that's been deleted from the library.
// Silent when everything's intact. Same X-Cron-Secret-or-session auth as the
// other /api/cron/* routes.
export async function POST(req: NextRequest) {
  const hasCronSecret = !!process.env.CRON_SECRET && req.headers.get("X-Cron-Secret") === process.env.CRON_SECRET;
  if (!hasCronSecret) {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const broken = findBrokenTracklists();
    if (broken.length > 0) {
      await cronNotify(
        `${brokenTracklistsMessage(broken)}\n\nOpen PaceSync and Quick Swap the highlighted tracks to repair.`,
        { title: `⚠ ${broken.length} broken tracklist${broken.length === 1 ? "" : "s"}`, tags: "warning", priority: "high", type: "ai-dj" },
      );
    }
    return NextResponse.json({ ok: true, broken: broken.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await cronNotify(`Broken-tracklist check failed: ${msg}`, { title: "⚠ Tracklist check failed", tags: "warning", type: "sync-error" }).catch(() => {});
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
