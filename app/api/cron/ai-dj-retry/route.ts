import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { buildAndSaveMixesFor } from "@/lib/ai-dj-prebuild";

// Runs daily at 06:00 (Pi local time, installed by deploy.py): re-checks
// TODAY's workout and backfills a mix if the 15:30 pre-build (app/api/cron/
// ai-dj/route.ts) missed it — e.g. Runna hadn't published or later reshuffled
// the workout before 15:30 the day before. Only builds workouts that still
// have nothing saved (see buildAndSaveMixesFor's "morning retry" branch) —
// a no-op on a day the evening job already succeeded.

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const hasCronSecret = cronSecret && req.headers.get("X-Cron-Secret") === cronSecret;
  if (!hasCronSecret) {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const today = new Date().toISOString().slice(0, 10);

  try {
    const result = await buildAndSaveMixesFor(today, "morning retry");
    return NextResponse.json(result);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: err }, { status: 500 });
  }
}
