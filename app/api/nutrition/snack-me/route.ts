import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { localIsoDate } from "@/lib/loseit-food";
import { snackSuggestions } from "@/lib/snack-builder";

export const dynamic = "force-dynamic";

// POST { kcalLeft } → snacks from the Lose It! history that fit under what is left of the day's calorie limit
// (lib/snack-builder.ts). Instant: it only reads the local food log.
export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => null) as { kcalLeft?: unknown } | null;
  const left = typeof b?.kcalLeft === "number" && Number.isFinite(b.kcalLeft) ? Math.min(b.kcalLeft, 3000) : null;
  if (left == null || left < 40) return NextResponse.json({ error: "kcalLeft must be at least 40" }, { status: 400 });
  return NextResponse.json(snackSuggestions(left, localIsoDate()));
}
