import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile } from "fs/promises";
import path from "path";

// Claude mixes run as a short-lived scripts/ai_dj_bridge.py subprocess per
// mix (see lib/ai-dj-mix.ts), so there's no long-running process to hold
// usage counters — ai_dj/llm.py persists them to this file after every
// mix instead. Same directory ai_dj/claude_config.py's claude-config.json
// lives in (the app root, one level up from the deployed ai_dj/ package).
const USAGE_PATH = path.join(process.cwd(), "claude-usage.json");

const PRICING: Record<string, [number, number]> = {
  "claude-sonnet-5": [3.0, 15.0],
  "claude-opus-4-8": [5.0, 25.0],
  "claude-haiku-4-5": [1.0, 5.0],
};

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const raw = await readFile(USAGE_PATH, "utf8");
    const usage = JSON.parse(raw) as Record<string, { input_tokens: number; output_tokens: number; requests: number }>;
    const models: Record<string, { inputTokens: number; outputTokens: number; requests: number; estimatedCostUsd: number }> = {};
    for (const [model, u] of Object.entries(usage)) {
      const [inPrice, outPrice] = PRICING[model] ?? [0, 0];
      models[model] = {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        requests: u.requests,
        estimatedCostUsd: Math.round(((u.input_tokens / 1_000_000) * inPrice + (u.output_tokens / 1_000_000) * outPrice) * 10_000) / 10_000,
      };
    }
    return NextResponse.json({ models });
  } catch {
    return NextResponse.json({ models: {} });
  }
}
