import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { syncLoseIt } from "@/lib/loseit-food";

export const dynamic = "force-dynamic";

// Hourly daytime cron: re-reads today's Lose It! diary (~4.6 KB), plus
// yesterday on the first run of a new day. Does nothing until an account is
// connected. Same X-Cron-Secret-or-session auth as the other /api/cron/* routes.
export async function POST(req: NextRequest) {
  const hasCronSecret = !!process.env.CRON_SECRET && req.headers.get("X-Cron-Secret") === process.env.CRON_SECRET;
  if (!hasCronSecret && !(await getServerSession(authOptions))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await syncLoseIt());
}
