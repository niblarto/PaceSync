import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { loadTestBudget, sanitizeTestBudget, saveTestBudget } from "@/lib/meal-test-budget";

export const dynamic = "force-dynamic";

// The test budget for "Create meal" (Settings → Nutrition): { enabled, kcal, proteinG, carbsG, fatG }.
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(loadTestBudget());
}

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  const budget = sanitizeTestBudget(body);
  saveTestBudget(budget);
  return NextResponse.json({ ok: true, ...budget });
}
