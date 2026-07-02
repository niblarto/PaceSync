import { loadAiDjConfig } from "@/lib/ai-dj-config";
import { readFile } from "fs/promises";
import { join } from "path";

// The AI DJ service may run a local LLM per workout segment — allow it time.
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

export type AiDjMixResult =
  | { ok: true; mix: AiDjMixResponse }
  | { ok: false; error: string };

export async function buildAiDjMix(title: string, segments: string[]): Promise<AiDjMixResult> {
  const config = loadAiDjConfig();
  if (!config?.enabled) {
    return { ok: false, error: "AI DJ is not enabled in Settings" };
  }
  if (!segments?.length) {
    return { ok: false, error: "segments required" };
  }

  let csv: string;
  try {
    csv = await readFile(join(process.cwd(), "public", "Running.csv"), "utf8");
  } catch {
    return { ok: false, error: "No library CSV - upload Running.csv in Settings first" };
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
      return { ok: false, error: data.error ?? `AI DJ service ${res.status}` };
    }
    return { ok: true, mix: data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = /timeout|abort/i.test(msg)
      ? "AI DJ service timed out"
      : `AI DJ service unreachable at ${config.url}`;
    return { ok: false, error: hint };
  }
}
