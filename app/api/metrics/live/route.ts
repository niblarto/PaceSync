import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { buildMetricsLive } from "@/lib/metrics-live";

export const dynamic = "force-dynamic";

// GET ?date=YYYY-MM-DD (the browser's today) → that day from midnight until now (heart rate, stress, Body Battery, steps,
// breathing, SpO2) and the headline gauge values.
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "date required" }, { status: 400 });
  try {
    return NextResponse.json(await buildMetricsLive(date, req.nextUrl.searchParams.get("force") === "1"));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
