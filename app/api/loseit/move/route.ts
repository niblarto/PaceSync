import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { isIsoDate } from "@/lib/nutrition";
import { placeLoseItFood } from "@/lib/loseit-food";

export const dynamic = "force-dynamic";

// Moves or copies a food to another meal of the same day (web Nutrition
// page's drag and drop).
//
// POST { date, mode: "move" | "copy", toMeal (0-3), item: { entryId, name, meal, kcal } }
// → that day's diary as re-read from Lose It!.

const isMeal = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 3;

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const { date, mode, toMeal } = b;
  const it = b.item as Record<string, unknown> | undefined;
  if (!isIsoDate(date) || (mode !== "move" && mode !== "copy") || !isMeal(toMeal)
    || typeof it?.name !== "string" || !isMeal(it.meal)) {
    return NextResponse.json({ error: "date, mode, toMeal and item are required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await placeLoseItFood(date, {
      entryId: typeof it.entryId === "string" ? it.entryId : null,
      name: it.name,
      meal: it.meal,
      kcal: typeof it.kcal === "number" ? it.kcal : null,
    }, toMeal, mode));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
