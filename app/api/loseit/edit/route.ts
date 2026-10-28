import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { isIsoDate } from "@/lib/nutrition";
import { editLoseItFood } from "@/lib/loseit-food";

export const dynamic = "force-dynamic";

// Changes the amount of a logged food (web Nutrition page: click a food).
//
// POST { date, quantity, unit?: "food" | "gram", item: { entryId, name, meal, kcal } }
// → that day's diary as re-read from Lose It!.

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const { date, quantity, unit } = b;
  const it = b.item as Record<string, unknown> | undefined;
  if (!isIsoDate(date) || typeof quantity !== "number" || !(quantity > 0) || (unit !== undefined && unit !== "food" && unit !== "gram")
    || typeof it?.name !== "string" || typeof it.meal !== "number" || !Number.isInteger(it.meal) || it.meal < 0 || it.meal > 3) {
    return NextResponse.json({ error: "date, quantity and item are required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await editLoseItFood(date, {
      entryId: typeof it.entryId === "string" ? it.entryId : null,
      name: it.name,
      meal: it.meal,
      kcal: typeof it.kcal === "number" ? it.kcal : null,
    }, quantity, unit === "gram" ? "gram" : "food"));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
