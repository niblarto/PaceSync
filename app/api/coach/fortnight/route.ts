import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { fortnightFacts } from "@/lib/coach-context";

export const dynamic = "force-dynamic";

// The Runna Summary card's "last two weeks" lines: training and recovery
// worked out from the Garmin data (no AI involved, so the figures are exact).
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const f = fortnightFacts();
  return NextResponse.json({ lines: [f.trainingLine, f.recoveryLine].filter(Boolean) });
}
