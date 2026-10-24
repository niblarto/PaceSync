import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { getBodyBattery } from "@/lib/body-battery";

export const dynamic = "force-dynamic";

// Today's Garmin Body Battery (cached for 5 minutes).
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ bodyBattery: await getBodyBattery() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Garmin request failed" }, { status: 502 });
  }
}
