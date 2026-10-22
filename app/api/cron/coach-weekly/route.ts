import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { cronNotify } from "@/lib/cron-notify";
import { generateWeeklyReport, weekLabel } from "@/lib/coach-weekly";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

// Weekly coach report ("coachWeekly" cron job, Sunday 19:00 by default).
// Same X-Cron-Secret-or-session auth as the other /api/cron/* routes.
export async function POST(req: NextRequest) {
  const hasCronSecret = !!process.env.CRON_SECRET && req.headers.get("X-Cron-Secret") === process.env.CRON_SECRET;
  if (!hasCronSecret && !(await getServerSession(authOptions))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await generateWeeklyReport();
  if (!result.ok) {
    await cronNotify(`The weekly coach report couldn't be written: ${result.error}`, {
      title: "⚠ Weekly coach report failed", tags: "warning", type: "sync-error",
    }).catch(() => {});
    return NextResponse.json({ error: result.error }, { status: 502 });
  }
  await cronNotify(`${result.verdict}\n\nThe full report is on the Coach page.`, {
    title: `🧠 Coach report · ${weekLabel(result.report.weekStart)}`, tags: "runner", type: "coach",
  }).catch(() => {});
  return NextResponse.json({ ok: true, id: result.report.id });
}
