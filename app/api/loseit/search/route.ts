import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { searchLoseItFoods } from "@/lib/loseit-food";

export const dynamic = "force-dynamic";

// GET ?q=banana → { foods: [{ pk, name, brand, icon, locale }] } from Lose It!'s food database.
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2 || q.length > 100) return NextResponse.json({ error: "Search for 2-100 characters" }, { status: 400 });
  try {
    return NextResponse.json({ foods: await searchLoseItFoods(q) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
