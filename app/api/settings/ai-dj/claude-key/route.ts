import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDb } from "@/lib/db";

// Claude mixes run on this Pi (scripts/ai_dj_bridge.py, no dependency on the
// separate Ollama-service PC being on), so the key is written here — the
// same pacesync.db row ai_dj/claude_config.py reads via Python's stdlib
// sqlite3 module (kv_config key "claude_config").
const KEY = "claude_config";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    const data = row ? JSON.parse(row.value_json) as { apiKey?: string } : {};
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
    getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
      .run(KEY, JSON.stringify({ apiKey: apiKey.trim() }));
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to save key: ${msg}` }, { status: 500 });
  }
}
