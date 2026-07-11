import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile } from "fs/promises";
import path from "path";
import { loadAiDjConfig } from "@/lib/ai-dj-config";

// Rolling log of prompts sent to the LLM during tracklist creation, written
// by ai_dj/llm.py (chat_json) wherever the call runs. Claude/Gemini mixes
// run on this Pi so their entries land in the local file; Ollama mixes run
// on the remote AI DJ service PC, which exposes its own log at /llm-log —
// both are merged here (remote fetched best-effort, skipped if the PC is
// off). Shown at the bottom of the Settings AI DJ card.
const LOG_PATH = path.join(process.cwd(), "ai-dj-llm-log.json");

export interface LlmLogEntry {
  ts: string;
  model: string;
  system: string;
  prompt: string;
  ok: boolean;
  error?: string;
  durationMs?: number;
  source?: "pi" | "service";
}

async function readLocalLog(): Promise<LlmLogEntry[]> {
  try {
    const raw = await readFile(LOG_PATH, "utf8");
    const entries = JSON.parse(raw) as LlmLogEntry[];
    return entries.map(e => ({ ...e, source: "pi" as const }));
  } catch {
    return [];
  }
}

async function readServiceLog(url: string): Promise<LlmLogEntry[]> {
  try {
    const res = await fetch(`${url}/llm-log`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return [];
    const data = await res.json() as { entries?: LlmLogEntry[] };
    return (data.entries ?? []).map(e => ({ ...e, source: "service" as const }));
  } catch {
    return []; // PC off/unreachable or old service build — local entries still show
  }
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const config = loadAiDjConfig();
  const [local, remote] = await Promise.all([
    readLocalLog(),
    config?.url ? readServiceLog(config.url) : Promise.resolve([]),
  ]);

  // Newest first across both sources; ISO timestamps sort lexicographically.
  const entries = [...local, ...remote].sort((a, b) => b.ts.localeCompare(a.ts));
  return NextResponse.json({ entries });
}
