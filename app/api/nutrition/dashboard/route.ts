import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { buildNutritionDashboard } from "@/lib/nutrition-dashboard";
import { refreshTodayBurn } from "@/lib/garmin-connect";

export const dynamic = "force-dynamic";

// GET ?days=30 → chart rows, weight history, averages and projections.
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const days = Math.min(365, Math.max(7, Number(req.nextUrl.searchParams.get("days")) || 30));
  const d = new Date();
  await refreshTodayBurn(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`).catch(() => null);
  return NextResponse.json(buildNutritionDashboard(days));
}
