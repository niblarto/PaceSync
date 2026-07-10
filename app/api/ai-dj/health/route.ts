import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

// Proxies a health check to the AI DJ service so the check runs from the Pi
// (which is what actually calls /mix) rather than the browser — avoids
// false negatives from CORS or the browser not sharing the Pi's network path.
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = req.nextUrl.searchParams.get("url");
  if (!url) return NextResponse.json({ error: "Missing url" }, { status: 400 });

  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return NextResponse.json({ ok: false, error: `HTTP ${res.status}` });
    const data = await res.json() as { ok?: boolean; llm?: boolean; claude?: boolean; claudeModels?: Record<string, string> };
    return NextResponse.json({ ok: !!data.ok, llm: !!data.llm, claude: !!data.claude, claudeModels: data.claudeModels ?? {} });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = /timeout|abort/i.test(msg) ? "Timed out" : "Unreachable";
    return NextResponse.json({ ok: false, error: hint });
  }
}
