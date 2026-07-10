import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadAiDjConfig } from "@/lib/ai-dj-config";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const config = loadAiDjConfig();
  if (!config?.url) return NextResponse.json({ error: "AI DJ service not configured" }, { status: 400 });

  try {
    const res = await fetch(`${config.url}/usage`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return NextResponse.json({ error: `AI DJ service ${res.status}` }, { status: 502 });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Could not reach AI DJ service: ${msg}` }, { status: 502 });
  }
}
