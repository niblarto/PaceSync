import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadAiDjConfig } from "@/lib/ai-dj-config";
import { readFile } from "fs/promises";
import { join } from "path";

// The AI DJ service may run a local LLM per workout segment - allow it time.
const MIX_TIMEOUT_MS = 180_000;

export interface AiDjMixResponse {
  trackUris: string[];
  totalSec: number;
  timeline: {
    segment: string;
    targetBpm: number;
    tracks: { uri: string; name: string; artist: string; startsAt: string; tempo: number; camelot: string | null; energy: number }[];
  }[];
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const config = loadAiDjConfig();
  if (!config?.enabled) {
    return NextResponse.json({ error: "AI DJ is not enabled in Settings" }, { status: 503 });
  }

  const { title, segments } = await req.json() as { title: string; segments: string[] };
  if (!segments?.length) {
    return NextResponse.json({ error: "segments required" }, { status: 400 });
  }

  let csv: string;
  try {
    csv = await readFile(join(process.cwd(), "public", "Running.csv"), "utf8");
  } catch {
    return NextResponse.json({ error: "No library CSV - upload Running.csv in Settings first" }, { status: 400 });
  }

  try {
    const res = await fetch(`${config.url}/mix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, segments, csv }),
      signal: AbortSignal.timeout(MIX_TIMEOUT_MS),
    });
    const data = await res.json() as AiDjMixResponse & { error?: string };
    if (!res.ok) {
      return NextResponse.json({ error: data.error ?? `AI DJ service ${res.status}` }, { status: 502 });
    }
    console.log(`[ai-dj] "${title}": ${data.trackUris.length} tracks, ${Math.round(data.totalSec / 60)} min`);
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = /timeout|abort/i.test(msg)
      ? "AI DJ service timed out"
      : `AI DJ service unreachable at ${config.url}`;
    console.error(`[ai-dj] ${msg}`);
    return NextResponse.json({ error: hint }, { status: 502 });
  }
}
