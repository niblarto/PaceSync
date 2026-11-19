import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { ensureHealthSummary, healthSummaryWriteState, isHealthSummaryDue, latestHealthSummary, nextCycleStart } from "@/lib/health-summary";

export const dynamic = "force-dynamic";

function snapshot() {
  return {
    summary: latestHealthSummary(),
    due: isHealthSummaryDue(),
    nextAt: nextCycleStart().toISOString(),
    ...healthSummaryWriteState(),
  };
}

// GET → latest summary + whether a new one is due / being written.
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(snapshot());
}

// POST → write the summary now if it's due and the AI is reachable (the page calls this every minute while one is due).
// POST ?force=1 → write a fresh one now even if today's exists (the refresh button).
export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const result = await ensureHealthSummary({ force: req.nextUrl.searchParams.get("force") === "1" });
  return NextResponse.json({ ...snapshot(), result });
}
