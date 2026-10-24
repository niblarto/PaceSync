import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { getTrainingReadiness } from "@/lib/training-readiness";

export const dynamic = "force-dynamic";

// The latest Garmin Training Readiness reading (cached for 10 minutes).
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const r = await getTrainingReadiness();
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
  return NextResponse.json({ readiness: r.readiness });
}
