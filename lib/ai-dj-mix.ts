import { loadAiDjConfig } from "@/lib/ai-dj-config";
import { loadGarminConfig } from "@/lib/garmin-config";
import { readFile } from "fs/promises";
import { join } from "path";
import { spawn } from "child_process";

// The AI DJ service may run a local LLM per workout segment — allow it time.
const MIX_TIMEOUT_MS = 180_000;
// The on-Pi fallback is deterministic (no LLM) but a Pi is slow at pandas.
const LOCAL_MIX_TIMEOUT_MS = 120_000;
const PYTHON = process.platform === "win32" ? "python" : "python3";

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

// Real cadence per 5s pace bucket from GarminDB (sec/mi -> SPM), sent to the
// remote AI DJ service so its pace->BPM uses measured turnover instead of a
// linear guess — the service host has no Garmin data of its own.
function loadCadenceBuckets(): Record<string, number> | null {
  const config = loadGarminConfig();
  if (!config) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(join(config.dbPath, "garmin_activities.db"), {
      readonly: true,
      fileMustExist: true,
    });
    db.pragma("busy_timeout = 30000");
    const rows = db.prepare(`
      SELECT CAST(3600.0 / r.speed / 5 AS INTEGER) * 5 AS bucket,
             AVG(r.cadence * 2) AS avg_spm
      FROM activity_records r
      JOIN activities a ON a.activity_id = r.activity_id
      WHERE LOWER(a.sport) LIKE '%running%'
        AND r.speed > 0.3 AND r.speed IS NOT NULL
        AND r.cadence IS NOT NULL AND r.cadence > 10
      GROUP BY bucket HAVING bucket BETWEEN 390 AND 600
      ORDER BY bucket
    `).all() as { bucket: number; avg_spm: number }[];
    db.close();
    if (rows.length === 0) return null;
    const buckets: Record<string, number> = {};
    rows.forEach(r => { buckets[String(r.bucket)] = r.avg_spm; });
    return buckets;
  } catch {
    return null;
  }
}

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
      body: JSON.stringify({ title, segments, csv, cadenceBuckets: loadCadenceBuckets() }),
      signal: AbortSignal.timeout(MIX_TIMEOUT_MS),
    });
    const data = await res.json() as AiDjMixResponse & { error?: string };
    if (!res.ok) {
      return { ok: false, error: data.error ?? `AI DJ service ${res.status}` };
    }
    return { ok: true, mix: data };
  } catch (err) {
    // Remote service unreachable (PC off/asleep) — build the mix on the Pi
    // itself with the deterministic distance-chain (no LLM). Same output
    // shape, and it uses the local Garmin DB for exact pace->BPM.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ai-dj] remote service failed (${msg}) — trying on-Pi fallback`);
    const local = await buildMixLocally(segments);
    if (local.ok) return local;
    const hint = /timeout|abort/i.test(msg)
      ? "AI DJ service timed out"
      : `AI DJ service unreachable at ${config.url}`;
    return { ok: false, error: `${hint} — on-Pi fallback also failed: ${local.error}` };
  }
}

function buildMixLocally(segments: string[]): Promise<AiDjMixResult> {
  const script = join(process.cwd(), "scripts", "ai_dj_bridge.py");
  const csvPath = join(process.cwd(), "public", "Running.csv");

  return new Promise((resolve) => {
    const proc = spawn(PYTHON, [script, csvPath]);
    const timer = setTimeout(() => { proc.kill(); }, LOCAL_MIX_TIMEOUT_MS);

    let stdout = "";
    let stderrTail = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-1000); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(stdout) as AiDjMixResponse & { error?: string };
        if (code !== 0 || data.error) {
          resolve({ ok: false, error: data.error ?? `bridge exited ${code}` });
          return;
        }
        console.log(`[ai-dj] on-Pi fallback built ${data.trackUris.length} tracks`);
        resolve({ ok: true, mix: data });
      } catch {
        resolve({ ok: false, error: stderrTail.trim().split("\n").pop() ?? `bridge exited ${code}` });
      }
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });

    proc.stdin.write(JSON.stringify({ segments }));
    proc.stdin.end();
  });
}
