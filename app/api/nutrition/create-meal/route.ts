import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { mealJob, startMealJob } from "@/lib/meal-builder";

export const dynamic = "force-dynamic";

// POST { remaining: { kcal, proteinG, carbsG, fatG } } → { jobId }: starts finding dinner suggestions: past dinners
// from the Lose It! food history that fit, plus the recipes the web search and recipe APIs return
// (lib/meal-builder.ts). The page polls GET for the outcome.

const n = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(v, 0), max) : null);

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const r = (b.remaining ?? {}) as Record<string, unknown>;
  const kcal = n(r.kcal, 3000), proteinG = n(r.proteinG, 300), carbsG = n(r.carbsG, 500), fatG = n(r.fatG, 200);
  if (kcal == null || kcal < 150 || proteinG == null || carbsG == null || fatG == null) {
    return NextResponse.json({ error: "remaining needs kcal (at least 150), proteinG, carbsG and fatG" }, { status: 400 });
  }
  return NextResponse.json({ jobId: startMealJob({ kcal, proteinG, carbsG, fatG }) });
}

// GET ?id=… → { status: "running" } | { status: "done", result } | { status: "error", error }; 404 once unknown or expired.
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const job = mealJob(req.nextUrl.searchParams.get("id") ?? "");
  return job ? NextResponse.json(job) : NextResponse.json({ error: "That meal request is gone (the server restarted or it expired) — press Regenerate" }, { status: 404 });
}
