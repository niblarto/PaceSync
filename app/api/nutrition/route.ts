import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { getNutritionDays, isIsoDate, normalizeDay, replaceNutritionRange, type NutritionDay } from "@/lib/nutrition";

export const dynamic = "force-dynamic";

// Daily nutrition totals (Lose It! → Health Connect → Android app).
//
// POST { from, to, days: [{ date, energyKcal, proteinG, carbsG, fatG, weightKg, source }] }
//   Replaces all rows in [from, to] with `days`.
// GET ?days=30  → the last N days (default 30, max 366).

const MAX_DAYS = 400;

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const b = body as { from?: unknown; to?: unknown; days?: unknown };
  if (!isIsoDate(b.from) || !isIsoDate(b.to) || b.from > b.to) {
    return NextResponse.json({ error: "from/to must be YYYY-MM-DD with from <= to" }, { status: 400 });
  }
  if (!Array.isArray(b.days) || b.days.length > MAX_DAYS) {
    return NextResponse.json({ error: `days must be an array of at most ${MAX_DAYS}` }, { status: 400 });
  }
  const from = b.from;
  const to = b.to;
  const days: NutritionDay[] = [];
  for (const raw of b.days) {
    const d = normalizeDay(raw);
    if (!d) return NextResponse.json({ error: "Invalid day entry" }, { status: 400 });
    if (d.date < from || d.date > to) {
      return NextResponse.json({ error: `Day ${d.date} outside ${from}..${to}` }, { status: 400 });
    }
    days.push(d);
  }

  const saved = replaceNutritionRange(from, to, days);
  return NextResponse.json({ ok: true, saved });
}

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const n = Math.min(366, Math.max(1, Number(req.nextUrl.searchParams.get("days")) || 30));
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - (n - 1));
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return NextResponse.json({ days: getNutritionDays(fmt(start), fmt(today)) });
}
