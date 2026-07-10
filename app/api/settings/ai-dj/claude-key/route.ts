import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile, writeFile } from "fs/promises";
import path from "path";

// Claude mixes run on this Pi (scripts/ai_dj_bridge.py, no dependency on the
// separate Ollama-service PC being on), so the key is written here — same
// file ai_dj/claude_config.py reads via its default path (one level up from
// the deployed ai_dj/ package, i.e. the app root).
const CLAUDE_CONFIG_PATH = path.join(process.cwd(), "claude-config.json");

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const data = JSON.parse(await readFile(CLAUDE_CONFIG_PATH, "utf8")) as { apiKey?: string };
    return NextResponse.json({ configured: !!data.apiKey?.trim() });
  } catch {
    return NextResponse.json({ configured: false });
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { apiKey } = await req.json() as { apiKey?: string };
  if (!apiKey?.trim()) return NextResponse.json({ error: "apiKey required" }, { status: 400 });

  try {
    await writeFile(CLAUDE_CONFIG_PATH, JSON.stringify({ apiKey: apiKey.trim() }), "utf8");
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to save key: ${msg}` }, { status: 500 });
  }
}
