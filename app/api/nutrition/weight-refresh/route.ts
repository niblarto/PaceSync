import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { refreshGarminWeights } from "@/lib/garmin-weight";

export const dynamic = "force-dynamic";

// POST → pull the last 30 days of weigh-ins from Garmin Connect now.
export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const result = await refreshGarminWeights(30);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
  return NextResponse.json(result);
}
