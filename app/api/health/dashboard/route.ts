import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { buildHealthDashboard } from "@/lib/health-dashboard";

export const dynamic = "force-dynamic";

// GET ?days=30 (7-120) → sleep and HRV per day from Garmin, with averages: the data behind the Health page.
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const n = Number(req.nextUrl.searchParams.get("days") ?? 30);
  const days = Number.isFinite(n) ? Math.min(120, Math.max(7, Math.round(n))) : 30;
  try {
    return NextResponse.json(await buildHealthDashboard(days));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
