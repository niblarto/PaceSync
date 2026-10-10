import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { fetchRunnaSchedule } from "@/lib/runna-schedule";
import { getTodaysRunEntriesForDate } from "@/lib/todays-run-history";
import { sendPush } from "@/lib/push";

// Daily digest push — today's Runna schedule entry + the first track of
// today's built playlist, fired at a user-configurable time via the
// "digest" cron job (Settings' cron table / Android Settings tab, both
// reading/writing lib/cron-schedule.ts's generic job store). Same
// X-Cron-Secret-or-session dual-auth as the other /api/cron/* routes —
// this is server-triggered, not something the Android app calls directly,
// so it uses the cron pattern rather than hasApiAccess's bearer token.
export async function POST(req: NextRequest) {
  const hasCronSecret = !!process.env.CRON_SECRET && req.headers.get("X-Cron-Secret") === process.env.CRON_SECRET;
  if (!hasCronSecret) {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const schedule = await fetchRunnaSchedule();
  const todaysWorkout = schedule.ok ? schedule.workouts.find(w => w.date === today) : null;

  const firstTrack = getTodaysRunEntriesForDate(today)[0]?.tracks[0] ?? null;

  const scheduleLine = todaysWorkout
    ? `${todaysWorkout.title}${todaysWorkout.distanceMi ? ` • ${todaysWorkout.distanceMi.toFixed(1)}mi` : ""}`
    : "No run scheduled today — rest day.";
  const trackLine = firstTrack
    ? `🎵 ${firstTrack.name} — ${firstTrack.artist}`
    : "Playlist not built yet.";

  const ok = await sendPush(`${scheduleLine}\n${trackLine}`, { title: "📅 Today's Run", type: "digest" });
  return NextResponse.json({ ok, scheduleLine, trackLine });
}
