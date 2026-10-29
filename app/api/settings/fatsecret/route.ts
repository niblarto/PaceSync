import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { loadFatSecret, saveFatSecret, searchFatSecret } from "@/lib/fatsecret";

export const dynamic = "force-dynamic";

// FatSecret Platform API credentials used by "Create meal". GET never returns the secret.
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const c = loadFatSecret();
  return NextResponse.json({ hasKey: !!c, hint: c ? `…${c.id.slice(-4)}` : null });
}

// POST {clientId, clientSecret} → test them with a real search, then save.
export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { clientId, clientSecret } = await req.json().catch(() => ({})) as { clientId?: string; clientSecret?: string };
  const id = (clientId ?? "").trim(), secret = (clientSecret ?? "").trim();
  if (!id || !secret) return NextResponse.json({ error: "Enter both the client ID and the client secret" }, { status: 400 });
  const test = await searchFatSecret("chicken", {}, { id, secret });
  if (!test.ok) return NextResponse.json({ error: test.error }, { status: 400 });
  saveFatSecret({ id, secret });
  return NextResponse.json({ ok: true, hasKey: true, hint: `…${id.slice(-4)}`, testResults: test.recipes.length });
}

export async function DELETE(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  saveFatSecret(null);
  return NextResponse.json({ ok: true, hasKey: false });
}
