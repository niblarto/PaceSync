import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { isIsoDate } from "@/lib/nutrition";
import { acceptMealItem } from "@/lib/meal-builder";

export const dynamic = "force-dynamic";

// POST { date, meal (0-3), item: { name, brand, amount, units, kcal } } → logs one suggested ingredient to the
// Lose It! diary; answers { day, logged } (the day as re-read from Lose It!, and what was really logged).

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const it = (b.item ?? {}) as Record<string, unknown>;
  if (!isIsoDate(b.date) || typeof b.meal !== "number" || !(b.meal >= 0 && b.meal <= 3)
    || typeof it.name !== "string" || typeof it.amount !== "number" || !(it.amount > 0) || typeof it.units !== "string") {
    return NextResponse.json({ error: "date, meal and item (name, amount, units) are required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await acceptMealItem({
      name: it.name, brand: typeof it.brand === "string" ? it.brand : null, amount: it.amount, units: it.units,
      kcal: typeof it.kcal === "number" ? it.kcal : 0,
    }, b.date, b.meal));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
