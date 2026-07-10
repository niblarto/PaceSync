import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { DEFAULT_CLAUDE_EFFORT, DEFAULT_CLAUDE_MODEL, DEFAULT_GEMINI_MODEL, loadAiDjConfig, saveAiDjConfig } from "@/lib/ai-dj-config";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const config = loadAiDjConfig();
  return NextResponse.json({
    url: config?.url ?? "", enabled: config?.enabled ?? false,
    autoPlaylist: config?.autoPlaylist ?? true, wolMac: config?.wolMac ?? "",
    provider: config?.provider ?? "local",
    claudeModel: config?.claudeModel ?? DEFAULT_CLAUDE_MODEL,
    claudeEffort: config?.claudeEffort ?? DEFAULT_CLAUDE_EFFORT,
    geminiModel: config?.geminiModel ?? DEFAULT_GEMINI_MODEL,
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { url, enabled, autoPlaylist, wolMac, provider, claudeModel, claudeEffort, geminiModel } = await req.json() as {
    url: string; enabled: boolean; autoPlaylist?: boolean; wolMac?: string;
    provider?: string; claudeModel?: string; claudeEffort?: string; geminiModel?: string;
  };
  saveAiDjConfig({
    url: url.trim().replace(/\/+$/, ""), enabled: !!enabled, autoPlaylist: autoPlaylist !== false, wolMac: (wolMac ?? "").trim(),
    provider: provider === "claude" ? "claude" : provider === "gemini" ? "gemini" : "local",
    claudeModel: (claudeModel ?? DEFAULT_CLAUDE_MODEL).trim() || DEFAULT_CLAUDE_MODEL,
    claudeEffort: (claudeEffort ?? DEFAULT_CLAUDE_EFFORT).trim() || DEFAULT_CLAUDE_EFFORT,
    geminiModel: (geminiModel ?? DEFAULT_GEMINI_MODEL).trim() || DEFAULT_GEMINI_MODEL,
  });
  return NextResponse.json({ ok: true });
}
