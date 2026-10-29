import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { loadNutritionConfig, sanitizeNutritionConfig, saveNutritionConfig } from "@/lib/nutrition-config";
import { buildNutritionDashboard, earliestGoalDate, MAX_LOSS_LB_PER_WEEK } from "@/lib/nutrition-dashboard";

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const dash = buildNutritionDashboard(7);
  return NextResponse.json({ ...loadNutritionConfig(), currentKg: dash.current?.avg7Kg ?? null, today: dash.today, maxLossLbPerWeek: MAX_LOSS_LB_PER_WEEK });
}

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const config = sanitizeNutritionConfig(body);

  // A goal date that would need more than 2 lb/week can't be saved.
  if (!config.goalDateAuto && config.goalDate && config.targetWeightKg != null) {
    const dash = buildNutritionDashboard(7);
    if (dash.current) {
      const earliest = earliestGoalDate(dash.current.avg7Kg, config.targetWeightKg, dash.today);
      if (config.goalDate < earliest) {
        const fmt = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
        return NextResponse.json({
          error: `That goal date needs more than ${MAX_LOSS_LB_PER_WEEK} lb a week. The earliest date is ${fmt(earliest)}.`,
          earliest,
        }, { status: 400 });
      }
    }
  }

  saveNutritionConfig(config);
  const dash = buildNutritionDashboard(7); // with the automatic goal date on, this refreshes it
  return NextResponse.json({ ok: true, ...loadNutritionConfig(), currentKg: dash.current?.avg7Kg ?? null, today: dash.today, maxLossLbPerWeek: MAX_LOSS_LB_PER_WEEK });
}
