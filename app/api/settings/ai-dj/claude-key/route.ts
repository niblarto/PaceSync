import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadAiDjConfig } from "@/lib/ai-dj-config";

// Forwards the Claude API key to the AI DJ service host, which holds it
// (not this Pi) since that's where the anthropic SDK calls originate.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const config = loadAiDjConfig();
  if (!config?.url) return NextResponse.json({ error: "Set the AI DJ service URL first" }, { status: 400 });

  const { apiKey } = await req.json() as { apiKey?: string };
  if (!apiKey?.trim()) return NextResponse.json({ error: "apiKey required" }, { status: 400 });

  try {
    const res = await fetch(`${config.url}/settings/claude-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: apiKey.trim() }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json() as { error?: string };
    if (!res.ok) return NextResponse.json({ error: data.error ?? `AI DJ service ${res.status}` }, { status: 502 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Could not reach AI DJ service: ${msg}` }, { status: 502 });
  }
}
