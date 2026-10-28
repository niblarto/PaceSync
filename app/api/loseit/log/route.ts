import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { isIsoDate } from "@/lib/nutrition";
import { addLoseItFood, removeLoseItFood } from "@/lib/loseit-food";

export const dynamic = "force-dynamic";

// Writes to the Lose It! diary (used by the web Nutrition page).
//
// POST   { pk, name, locale, date, meal (0-3), quantity } → add a food; quantity is in the food's own unit
// DELETE { date, entryId }                                → remove a food
// Both answer with the day's diary as re-read from Lose It!.

async function body(req: NextRequest): Promise<Record<string, unknown> | null> {
  try { return await req.json(); } catch { return null; }
}

function failed(e: unknown) {
  return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
}

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await body(req);
  if (!b) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  const { pk, name, locale, brand, icon, date, meal, quantity } = b;
  if (typeof pk !== "string" || typeof name !== "string" || !isIsoDate(date)
    || typeof meal !== "number" || typeof quantity !== "number") {
    return NextResponse.json({ error: "pk, name, date, meal and quantity are required" }, { status: 400 });
  }
  try {
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    return NextResponse.json(await addLoseItFood({ pk, name, locale: str(locale), brand: str(brand), icon: str(icon) }, date, meal, quantity));
  } catch (e) {
    return failed(e);
  }
}

export async function DELETE(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await body(req);
  const date = b?.date, entryId = b?.entryId;
  if (!isIsoDate(date) || typeof entryId !== "string") {
    return NextResponse.json({ error: "date and entryId are required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await removeLoseItFood(date, entryId));
  } catch (e) {
    return failed(e);
  }
}
