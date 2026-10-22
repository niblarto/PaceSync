import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { ensureSummary, isSummaryDue, latestSummary, nextCycleStart, summaryWriteState } from "@/lib/nutrition-summary";

export const dynamic = "force-dynamic";

function snapshot() {
  return {
    summary: latestSummary(),
    due: isSummaryDue(),
    nextAt: nextCycleStart().toISOString(),
    ...summaryWriteState(),
  };
}

// GET → latest summary + whether a new one is due / being written.
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(snapshot());
}

// POST → write the summary now if it's due and the AI is reachable.
// The page calls this every minute while a summary is due.
export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const result = await ensureSummary();
  return NextResponse.json({ ...snapshot(), result });
}
