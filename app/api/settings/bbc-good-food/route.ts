import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { bgfEnabled, setBgfEnabled } from "@/lib/bbc-good-food";

export const dynamic = "force-dynamic";

// Whether "Create meal" reads recipes from bbcgoodfood.com (lib/bbc-good-food.ts). Off until switched on here.
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ enabled: bgfEnabled() });
}

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") return NextResponse.json({ error: "enabled (true/false) required" }, { status: 400 });
  setBgfEnabled(body.enabled);
  return NextResponse.json({ ok: true, enabled: body.enabled });
}
