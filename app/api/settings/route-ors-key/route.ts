import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { loadOrsKey, saveOrsKey, testOrsKey } from "@/lib/ors";

export const dynamic = "force-dynamic";

// OpenRouteService key for the Route Finder's street routing. GET never
// returns the key itself.
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const key = loadOrsKey();
  return NextResponse.json({ hasKey: !!key, hint: key ? `…${key.slice(-4)}` : null });
}

// POST {key} → test it with a real (tiny) routing request, then save it.
export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { key } = await req.json().catch(() => ({})) as { key?: string };
  const k = (key ?? "").trim();
  if (!k) return NextResponse.json({ error: "Paste a key first" }, { status: 400 });
  const test = await testOrsKey(k);
  if (!test.ok) return NextResponse.json({ error: test.error }, { status: 400 });
  saveOrsKey(k);
  return NextResponse.json({ ok: true, hasKey: true, hint: `…${k.slice(-4)}` });
}

export async function DELETE(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  saveOrsKey(null);
  return NextResponse.json({ ok: true, hasKey: false });
}
