import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { loadOllamaWebKey, ollamaWebSearch, saveOllamaWebKey } from "@/lib/web-search";

export const dynamic = "force-dynamic";

// The Coach's web search key (Ollama). GET never returns the key itself.
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const key = loadOllamaWebKey();
  return NextResponse.json({ hasKey: !!key, hint: key ? `…${key.slice(-4)}` : null });
}

// POST {key} → test it with a real search, then save it.
export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { key } = await req.json().catch(() => ({})) as { key?: string };
  const k = (key ?? "").trim();
  if (!k) return NextResponse.json({ error: "Paste a key first" }, { status: 400 });
  const test = await ollamaWebSearch("marathon training protein intake", k);
  if (!test.ok) return NextResponse.json({ error: test.error }, { status: 400 });
  saveOllamaWebKey(k);
  return NextResponse.json({ ok: true, hasKey: true, hint: `…${k.slice(-4)}`, testResults: test.results.length });
}

export async function DELETE(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  saveOllamaWebKey(null);
  return NextResponse.json({ ok: true, hasKey: false });
}
