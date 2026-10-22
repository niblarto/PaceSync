import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { loadNutritionConfig, sanitizeNutritionConfig, saveNutritionConfig } from "@/lib/nutrition-config";

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(loadNutritionConfig());
}

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const config = sanitizeNutritionConfig(body);
  saveNutritionConfig(config);
  return NextResponse.json({ ok: true, ...config });
}
