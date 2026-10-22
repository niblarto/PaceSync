import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { ensureSummary } from "@/lib/nutrition-summary";

export const dynamic = "force-dynamic";

// Hourly cron: writes the daily nutrition summary once it's due (after
// 05:00) and the AI DJ service is up. Does nothing if today's is already
// written. Same X-Cron-Secret-or-session auth as the other /api/cron/* routes.
export async function POST(req: NextRequest) {
  const hasCronSecret = !!process.env.CRON_SECRET && req.headers.get("X-Cron-Secret") === process.env.CRON_SECRET;
  if (!hasCronSecret && !(await getServerSession(authOptions))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await ensureSummary();
  return NextResponse.json(result);
}
