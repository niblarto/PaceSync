import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { DEFAULT_CLAUDE_EFFORT, DEFAULT_CLAUDE_MODEL, DEFAULT_GEMINI_MODEL } from "@/lib/ai-dj-config";
import { loadCoachConfig, saveCoachConfig } from "@/lib/coach-config";

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(loadCoachConfig());
}

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json() as { provider?: string; claudeModel?: string; claudeEffort?: string; geminiModel?: string; ollamaModel?: string };
  const config = {
    provider: b.provider === "claude" ? "claude" as const : b.provider === "gemini" ? "gemini" as const : "local" as const,
    claudeModel: (b.claudeModel ?? "").trim() || DEFAULT_CLAUDE_MODEL,
    claudeEffort: (b.claudeEffort ?? "").trim() || DEFAULT_CLAUDE_EFFORT,
    geminiModel: (b.geminiModel ?? "").trim() || DEFAULT_GEMINI_MODEL,
    ollamaModel: (b.ollamaModel ?? "").trim(),
  };
  saveCoachConfig(config);
  return NextResponse.json({ ok: true, ...config });
}
