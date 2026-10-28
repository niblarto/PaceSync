import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { isIsoDate } from "@/lib/nutrition";
import { copyLoseItFoods, type CopyItem } from "@/lib/loseit-food";

export const dynamic = "force-dynamic";

// Copies logged foods into today's Lose It! diary (web Nutrition page).
//
// POST { fromDate, meal }                 → the whole meal, into the same meal today
// POST { fromDate, items: [...], toMeal } → these foods ({ entryId, name, meal, kcal }) into `toMeal` today
// → { copied, toDate, day } with today's diary as re-read from Lose It!.

const isMeal = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 3;

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const { fromDate, meal, items, toMeal } = b;
  if (!isIsoDate(fromDate)) return NextResponse.json({ error: "fromDate must be YYYY-MM-DD" }, { status: 400 });

  let what: { meal: number } | { items: CopyItem[]; toMeal: number };
  if (isMeal(meal) && items === undefined) {
    what = { meal };
  } else if (Array.isArray(items) && items.length > 0 && items.length <= 50 && isMeal(toMeal)) {
    const parsed: CopyItem[] = [];
    for (const raw of items) {
      const it = raw as Record<string, unknown>;
      if (typeof it?.name !== "string" || !isMeal(it.meal)) return NextResponse.json({ error: "Invalid item" }, { status: 400 });
      parsed.push({
        entryId: typeof it.entryId === "string" ? it.entryId : null,
        name: it.name,
        meal: it.meal,
        kcal: typeof it.kcal === "number" ? it.kcal : null,
      });
    }
    what = { items: parsed, toMeal };
  } else {
    return NextResponse.json({ error: "Send either meal, or items and toMeal" }, { status: 400 });
  }

  try {
    return NextResponse.json(await copyLoseItFoods(fromDate, what));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
