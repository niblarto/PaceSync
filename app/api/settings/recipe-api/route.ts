import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { loadRecipeKey, saveRecipeKey, searchRecipes } from "@/lib/recipe-api";

export const dynamic = "force-dynamic";

// The recipe API key (API Ninjas) used by "Create meal". GET never returns the key itself.
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const key = loadRecipeKey();
  return NextResponse.json({ hasKey: !!key, hint: key ? `…${key.slice(-4)}` : null });
}

// POST {key} → test it with a real search, then save it.
export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { key } = await req.json().catch(() => ({})) as { key?: string };
  const k = (key ?? "").trim();
  if (!k) return NextResponse.json({ error: "Paste a key first" }, { status: 400 });
  const test = await searchRecipes("chicken", k);
  if (!test.ok) return NextResponse.json({ error: test.error }, { status: 400 });
  saveRecipeKey(k);
  return NextResponse.json({ ok: true, hasKey: true, hint: `…${k.slice(-4)}`, testResults: test.recipes.length });
}

export async function DELETE(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  saveRecipeKey(null);
  return NextResponse.json({ ok: true, hasKey: false });
}
