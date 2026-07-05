import { loadAiDjConfig } from "@/lib/ai-dj-config";
import { loadGarminConfig } from "@/lib/garmin-config";
import { computeEasyPaceBias } from "@/lib/run-pace-bias";
import { getAllTrackVotes } from "@/lib/track-feedback";
import { readFile } from "fs/promises";
import { join } from "path";
import { spawn } from "child_process";
import { activeCsvPath } from "@/lib/running-playlist-config";

// The AI DJ service may run a local LLM per workout segment — allow it time.
const MIX_TIMEOUT_MS = 180_000;
// The on-Pi fallback is deterministic (no LLM) but a Pi is slow at pandas.
const LOCAL_MIX_TIMEOUT_MS = 180_000;
const PYTHON = process.platform === "win32" ? "python" : "python3";

export interface AiDjMixResponse {
  trackUris: string[];
  totalSec: number;
  timeline: {
    segment: string;
    targetBpm: number;
    targetPaceSec?: number | null;
    tracks: { uri: string; name: string; artist: string; startsAt: string; durationSec?: number; tempo: number; camelot: string | null; energy: number }[];
  }[];
}

export type AiDjMixResult =
  | { ok: true; mix: AiDjMixResponse }
  | { ok: false; error: string };

// Fired as each workout segment starts building (the per-segment LLM call is
// the slow part) — lets the API route stream a real progress bar.
export type AiDjProgress = (current: number, total: number, segment: string) => void;

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

// Parses the SSE stream from the AI DJ service's /mix/stream endpoint.
// Returns null when the endpoint doesn't exist (service not yet restarted on
// the new code) so the caller can fall back to the plain /mix endpoint.
async function fetchMixStream(url: string, body: string, onProgress: AiDjProgress): Promise<AiDjMixResult | null> {
  const res = await fetch(`${url}/mix/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(MIX_TIMEOUT_MS),
  });
  if (res.status === 404 || res.status === 405) return null; // old service build
  if (!res.ok || !res.body) {
    let msg = `AI DJ service ${res.status}`;
    try {
      const data = await res.json() as { error?: string };
      if (data.error) msg = data.error;
    } catch { /* non-JSON error body */ }
    return { ok: false, error: msg };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLine = chunk.split("\n").find(l => l.startsWith("data: "));
      if (!dataLine) continue; // padding/comment frame
      const msg = JSON.parse(dataLine.slice(6)) as
        & Partial<AiDjMixResponse>
        & { type: string; current?: number; total?: number; segment?: string; error?: string };
      if (msg.type === "progress") {
        onProgress(msg.current ?? 0, msg.total ?? 1, msg.segment ?? "");
      } else if (msg.type === "done") {
        return { ok: true, mix: { trackUris: msg.trackUris!, totalSec: msg.totalSec!, timeline: msg.timeline! } };
      } else if (msg.type === "error") {
        return { ok: false, error: msg.error ?? "AI DJ service error" };
      }
    }
  }
  return { ok: false, error: "AI DJ stream ended without a result" };
}

export async function buildAiDjMix(title: string, segments: string[], onProgress?: AiDjProgress): Promise<AiDjMixResult> {
  const config = loadAiDjConfig();
  if (!config?.enabled) {
    return { ok: false, error: "AI DJ is not enabled in Settings" };
  }
  if (!segments?.length) {
    return { ok: false, error: "segments required" };
  }

  let csv: string;
  try {
    csv = await readFile(activeCsvPath(), "utf8");
  } catch {
    return { ok: false, error: "No library CSV - upload a playlist library in Settings first" };
  }

  const easyBias = computeEasyPaceBias();
  if (easyBias > 0) console.log(`[ai-dj] recent easy runs ran ~${easyBias}s/mi fast — easing easy segments`);
  const trackFeedback = getAllTrackVotes();

  const body = JSON.stringify({ title, segments, csv, cadenceBuckets: loadCadenceBuckets(), easyBias, trackFeedback });
  try {
    if (onProgress) {
      const streamed = await fetchMixStream(config.url, body, onProgress);
      if (streamed) return streamed;
      // null = service predates /mix/stream — fall through to plain /mix
    }
    const res = await fetch(`${config.url}/mix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
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
    const local = await buildMixLocally(segments, easyBias, trackFeedback, onProgress);
    if (local.ok) return local;
    const hint = /timeout|abort/i.test(msg)
      ? "AI DJ service timed out"
      : `AI DJ service unreachable at ${config.url}`;
    return { ok: false, error: `${hint} — on-Pi fallback also failed: ${local.error}` };
  }
}

function buildMixLocally(
  segments: string[], easyBias = 0, trackFeedback: object[] = [], onProgress?: AiDjProgress
): Promise<AiDjMixResult> {
  const script = join(process.cwd(), "scripts", "ai_dj_bridge.py");
  const csvPath = activeCsvPath();

  return new Promise((resolve) => {
    const proc = spawn(PYTHON, [script, csvPath]);
    const timer = setTimeout(() => { proc.kill(); }, LOCAL_MIX_TIMEOUT_MS);

    // The bridge prints NDJSON: {"type":"progress",...} lines as segments
    // build, then a final mix (or {"error":...}) JSON line.
    let lineBuf = "";
    let lastPayload = "";
    let stderrTail = "";
    const takeLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as { type?: string; current?: number; total?: number; segment?: string };
        if (msg.type === "progress") {
          onProgress?.(msg.current ?? 0, msg.total ?? 1, msg.segment ?? "");
          return;
        }
      } catch { /* partial or non-JSON line — treat as payload candidate */ }
      lastPayload = line;
    };
    proc.stdout.on("data", (d: Buffer) => {
      lineBuf += d.toString();
      let nl;
      while ((nl = lineBuf.indexOf("\n")) !== -1) {
        takeLine(lineBuf.slice(0, nl));
        lineBuf = lineBuf.slice(nl + 1);
      }
    });
    proc.stderr.on("data", (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-1000); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      takeLine(lineBuf);
      try {
        const data = JSON.parse(lastPayload) as AiDjMixResponse & { error?: string };
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

    proc.stdin.write(JSON.stringify({ segments, easyBias, trackFeedback }));
    proc.stdin.end();
  });
}
