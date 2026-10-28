import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { getLoseItFoodDetails, type FoodRef } from "@/lib/loseit-food";

export const dynamic = "force-dynamic";

// POST { pk, name, locale } (a search result) → the food's default amount,
// unit and calories/macros for that amount, as Lose It! would pre-fill them.
export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let b: Partial<FoodRef>;
  try { b = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (typeof b.pk !== "string" || typeof b.name !== "string") return NextResponse.json({ error: "pk and name are required" }, { status: 400 });
  try {
    return NextResponse.json(await getLoseItFoodDetails({ pk: b.pk, name: b.name, locale: typeof b.locale === "string" ? b.locale : null }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
