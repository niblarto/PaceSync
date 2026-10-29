import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { isIsoDate } from "@/lib/nutrition";
import { acceptRecipeIngredient } from "@/lib/meal-builder";

export const dynamic = "force-dynamic";

// POST { date, meal (0-3), item: { name, amount, unit: "g" | "ml" | "count", countUnit, keep?: { key, quantity }, food?: { pk, name, locale, brand, icon } } } → logs one recipe
// ingredient (amount already metric and scaled to the servings eaten) to the Lose It! diary; answers
// { day, logged } like /api/nutrition/create-meal/accept.

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const it = (b.item ?? {}) as Record<string, unknown>;
  if (!isIsoDate(b.date) || typeof b.meal !== "number" || !(b.meal >= 0 && b.meal <= 3)
    || typeof it.name !== "string" || typeof it.amount !== "number" || !(it.amount > 0) || (it.unit !== "g" && it.unit !== "ml" && it.unit !== "count")) {
    return NextResponse.json({ error: "date, meal and item (name, amount, unit g/ml/count) are required" }, { status: 400 });
  }
  try {
    const keep = (it.keep ?? null) as { key?: unknown; quantity?: unknown } | null;
    const f = (it.food ?? null) as Record<string, unknown> | null;
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    return NextResponse.json(await acceptRecipeIngredient({
      food: f && typeof f.pk === "string" && typeof f.name === "string" ? { pk: f.pk, name: f.name, locale: str(f.locale), brand: str(f.brand), icon: str(f.icon) } : null,
      name: it.name, amount: it.amount, unit: it.unit, countUnit: typeof it.countUnit === "string" ? it.countUnit : null,
      keep: keep && typeof keep.key === "string" && typeof keep.quantity === "number" && keep.quantity > 0 ? { key: keep.key, quantity: keep.quantity } : null,
    }, b.date, b.meal));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
