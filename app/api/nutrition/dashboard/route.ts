import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { buildNutritionDashboard } from "@/lib/nutrition-dashboard";
import { refreshTodayBurn } from "@/lib/garmin-connect";
import { syncLoseIt } from "@/lib/loseit-food";

export const dynamic = "force-dynamic";

// GET ?days=30 → chart rows, weight history, averages and projections.
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const days = Math.min(365, Math.max(7, Number(req.nextUrl.searchParams.get("days")) || 30));
  const d = new Date();
  // Today's Garmin burn and today's Lose It! food (the food sync is throttled
  // to once per 5 minutes inside syncLoseIt, a few KB when it runs). The web
  // page's automatic reloads pass sync=0 so they don't poll Lose It!.
  await Promise.all([
    refreshTodayBurn(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`).catch(() => null),
    req.nextUrl.searchParams.get("sync") === "0" ? null : syncLoseIt().catch(() => null),
  ]);
  return NextResponse.json(buildNutritionDashboard(days));
}
