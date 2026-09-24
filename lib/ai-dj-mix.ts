import { loadAiDjConfig } from "@/lib/ai-dj-config";
import { loadGarminConfig } from "@/lib/garmin-config";
import { computeEasyPaceBias } from "@/lib/run-pace-bias";
import { getAllTrackVotes } from "@/lib/track-feedback";
import { getPlayedTracks, getLastEasyPaceSec } from "@/lib/todays-run-history";
import { getPlayCounts } from "@/lib/play-counts";
import { loadBpmOverrides } from "@/lib/bpm-overrides";
import { join } from "path";
import { spawn } from "child_process";
import { dbSourcePath, loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { csvTextForPlaylist } from "@/lib/tracks-store";

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
    targetBpm: number | null;
    targetPaceSec?: number | null;
    tracks: { uri: string; name: string; artist: string; startsAt: string; durationSec?: number; tempo: number; camelot: string | null; energy: number }[];
  }[];
  // Segments where the LLM call failed (rate limit, quota, network) and fell
  // back to the deterministic distance-chain — one string per segment, e.g.
  // "Warm up: Gemini API request failed: 429 RESOURCE_EXHAUSTED...".
  llmFailures?: string[];
}

export type AiDjMixResult =
  | { ok: true; mix: AiDjMixResponse }
  | { ok: false; error: string };

// Fired as each workout segment starts building (the per-segment LLM call is
// the slow part) — lets the API route stream a real progress bar. `detail`
// carries the LLM interaction status for that segment (candidates sent,
// tracks returned, fallback) when the builder reports one.
export type AiDjProgress = (current: number, total: number, segment: string, detail?: string, candidateUris?: string[]) => void;

// Fired once per LLM call during a "simulate a mix" run (Settings -> BPM),
// carrying the full untruncated prompt/response — never sent for a real mix
// build (only wired when the underlying Python payload sets `simulate: true`).
export type AiDjLlmEvent = { system: string; user: string; ok: boolean; response?: string; error?: string };
export type AiDjLlmCallback = (event: AiDjLlmEvent) => void;

// Real cadence per 5s pace bucket from GarminDB (sec/mi -> SPM), sent to the
// remote AI DJ service so its pace->BPM uses measured turnover instead of a
// linear guess — the service host has no Garmin data of its own.
export function loadCadenceBuckets(): Record<string, number> | null {
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
async function fetchMixStream(url: string, body: string, onProgress: AiDjProgress, endpoint = "/mix/stream", onLlm?: AiDjLlmCallback): Promise<AiDjMixResult | null> {
  const res = await fetch(`${url}${endpoint}`, {
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
        & Partial<AiDjLlmEvent>
        & { type: string; current?: number; total?: number; segment?: string; detail?: string; error?: string; candidateUris?: string[] };
      if (msg.type === "progress") {
        onProgress(msg.current ?? 0, msg.total ?? 1, msg.segment ?? "", msg.detail, msg.candidateUris);
      } else if (msg.type === "llm") {
        onLlm?.({ system: msg.system ?? "", user: msg.user ?? "", ok: msg.ok ?? false, response: msg.response, error: msg.error });
      } else if (msg.type === "done") {
        return { ok: true, mix: { trackUris: msg.trackUris!, totalSec: msg.totalSec!, timeline: msg.timeline!, llmFailures: msg.llmFailures } };
      } else if (msg.type === "error") {
        return { ok: false, error: msg.error ?? "AI DJ service error" };
      }
    }
  }
  return { ok: false, error: "AI DJ stream ended without a result" };
}

// Adds each URI's extra count on top of its real history play count (rather
// than overwriting it), so a track that's genuinely been played a lot AND
// was just removed from this mix stacks both penalties.
function mergePlayCounts(base: Record<string, number>, extra?: Record<string, number>): Record<string, number> {
  if (!extra) return base;
  const merged = { ...base };
  for (const [uri, n] of Object.entries(extra)) merged[uri] = (merged[uri] ?? 0) + n;
  return merged;
}

// avoidUris: tracks from the mix being rebuilt ("Remix") — the mixer demotes
// them like already-played tracks so a rebuild comes out mostly different.
// extraPlayCounts: tracks explicitly "removed from mix" this session — added
// on top of their real play count so the weighted sort demotes them hard
// (min(count,10)*PLAY_COUNT_WEIGHT already hits the max penalty at count=1)
// without excluding them outright, matching PLAY_COUNT_WEIGHT's own scale.
// strictPaceTolerance: hard-excludes any candidate whose effective BPM
// undershoots a segment's target by more than the tightest ("work") band —
// no upper limit — bypassing the kind-based Settings BPM overrides
// entirely. Used by Pace Pro mixes, where every split IS the pace target
// (see ai_dj/workout.py's build_workout_playlist docstring for the exact
// rule, which matches lib/pace-analysis.ts's classifyPaceFit()).
// segmentCandidateUris: one entry per `segments` line (null/missing = no
// restriction for that segment). When given, that segment's pool is
// restricted to ONLY these URIs first, falling back to the normal
// (strictPaceTolerance-filtered, if set) full-library search only if that
// restricted list can't fill the segment's own time budget — see
// ai_dj/workout.py's build_workout_playlist docstring. Used by Pace Pro to
// hand the LLM exactly lib/pace-analysis.ts's "fits" list per split.
export async function buildAiDjMix(title: string, segments: string[], onProgress?: AiDjProgress, avoidUris?: string[], extraPlayCounts?: Record<string, number>, strictPaceTolerance?: boolean, segmentCandidateUris?: (string[] | null)[]): Promise<AiDjMixResult> {
  const config = loadAiDjConfig();
  if (!config?.enabled) {
    return { ok: false, error: "AI DJ is not enabled in Settings" };
  }
  if (!segments?.length) {
    return { ok: false, error: "segments required" };
  }

  // Rows missing Duration/BPM data are excluded from the mix pool — the mix
  // build is local/CSV-only and never touches Spotify itself; fixing gaps
  // is a deliberate Settings -> "Heal now" action, and /api/ai-dj/mix scans
  // and warns about anything still incomplete.
  let csv: string;
  try {
    csv = csvTextForPlaylist(loadRunningPlaylistConfig().csvFile);
    if (!csv.trim()) throw new Error("empty library");
  } catch {
    return { ok: false, error: "No library CSV - upload a playlist library in Settings first" };
  }

  const easyBias = computeEasyPaceBias();
  if (easyBias > 0) console.log(`[ai-dj] recent easy runs ran ~${easyBias}s/mi fast — easing easy segments`);
  const trackFeedback = getAllTrackVotes();
  const playCounts = mergePlayCounts(getPlayCounts(), extraPlayCounts);

  // Claude/Gemini run right here on the Pi via the on-Pi bridge — no
  // dependency on the separate Ollama service PC being on. Ollama-backed
  // "local" mixes still need that PC (its GPU runs the model), so those go
  // over HTTP.
  if (config.provider === "claude") {
    return buildMixLocally(segments, easyBias, trackFeedback, playCounts, onProgress, avoidUris, config.claudeModel, config.claudeEffort, strictPaceTolerance, segmentCandidateUris);
  }
  if (config.provider === "gemini") {
    return buildMixLocally(segments, easyBias, trackFeedback, playCounts, onProgress, avoidUris, config.geminiModel, undefined, strictPaceTolerance, segmentCandidateUris);
  }

  const lastEasyPaceSec = getLastEasyPaceSec();
  const body = JSON.stringify({
    title, segments, csv, cadenceBuckets: loadCadenceBuckets(), easyBias, trackFeedback,
    playedTracks: getPlayedTracks(), playCounts, bpmOverrides: loadBpmOverrides(),
    avoidTracks: avoidUris?.length ? avoidUris : undefined,
    // Remote AI DJ service (ai_dj/server.py) expects "MM:SS", not seconds.
    easyPace: lastEasyPaceSec != null ? `${Math.floor(lastEasyPaceSec / 60)}:${String(Math.round(lastEasyPaceSec % 60)).padStart(2, "0")}` : undefined,
    // Omitted -> the service falls back to its own --model startup default
    // (see ai_dj/server.py's _build_mix_payload).
    model: config.ollamaModel || undefined,
    strictPaceTolerance,
    segmentCandidateUris,
  });
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
    const local = await buildMixLocally(segments, easyBias, trackFeedback, playCounts, onProgress, avoidUris, undefined, undefined, strictPaceTolerance, segmentCandidateUris);
    if (local.ok) return local;
    const hint = /timeout|abort/i.test(msg)
      ? "AI DJ service timed out"
      : `AI DJ service unreachable at ${config.url}`;
    return { ok: false, error: `${hint} — on-Pi fallback also failed: ${local.error}` };
  }
}

// Dashboard chart's multi-select "🤖 AI Remix…" — same job as the
// deterministic replace-candidates-budget route (fill the selected tracks'
// combined duration with tracks at one target BPM, avoiding what's already
// selected), but the LLM does the picking instead of a closest-fit search.
// Reuses buildAiDjMix's whole pipeline (remote service, on-Pi Claude/Gemini
// bridge, Ollama) unmodified by writing ONE synthetic segment line in the
// "Ns at Xbpm" form ai_dj/workout.py's parse_workout recognizes as a
// literal BPM target — no pace_to_bpm conversion, no Settings sweet-spot/
// bounds shift, just the user's own typed BPM (see Segment.literal_bpm in
// workout.py). "work" tolerance band applies (BPM_TOLERANCES, tight/
// symmetric) — the same standard tolerance every other BPM match in this
// app uses. Whole SECONDS, not minutes — this app's every other BPM-fill
// path (replace-candidates-budget, Remix…) works to a ±15s tolerance, so
// rounding the budget to the nearest minute first (an earlier version of
// this) could already be off by up to 30s before the fit search even ran.
export async function buildAiDjRemix(targetBpm: number, budgetMs: number, avoidUris: string[], onProgress?: AiDjProgress): Promise<AiDjMixResult> {
  const seconds = Math.max(1, Math.round(budgetMs / 1000));
  const segment = `${seconds}s at ${Math.round(targetBpm)}bpm`;
  return buildAiDjMix("AI Remix", [segment], onProgress, avoidUris);
}

// Spawns scripts/ai_dj_bridge.py with `stdinPayload` and parses its NDJSON
// progress lines + final mix/error JSON line — shared by the segment-based
// mix and the flow-mix (fixed track pool) modes, which differ only in what
// they write to stdin.
function runBridge(stdinPayload: object, onProgress?: AiDjProgress, onLlm?: AiDjLlmCallback): Promise<AiDjMixResult> {
  const script = join(process.cwd(), "scripts", "ai_dj_bridge.py");
  const csvPath = dbSourcePath();

  return new Promise((resolve) => {
    const proc = spawn(PYTHON, [script, csvPath]);
    const timer = setTimeout(() => { proc.kill(); }, LOCAL_MIX_TIMEOUT_MS);

    let lineBuf = "";
    let lastPayload = "";
    let stderrTail = "";
    const takeLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as AiDjLlmEvent & { type?: string; current?: number; total?: number; segment?: string; detail?: string; candidateUris?: string[] };
        if (msg.type === "progress") {
          onProgress?.(msg.current ?? 0, msg.total ?? 1, msg.segment ?? "", msg.detail, msg.candidateUris);
          return;
        }
        if (msg.type === "llm") {
          onLlm?.({ system: msg.system, user: msg.user, ok: msg.ok, response: msg.response, error: msg.error });
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

    proc.stdin.write(JSON.stringify(stdinPayload));
    proc.stdin.end();
  });
}

// Runs one synthetic single-segment mix through the exact same pipeline as
// a real mix build (Settings -> BPM -> "Simulate a mix"), surfacing every
// LLM prompt/response via onLlm. Never persists anything — no
// recordMixBuild/setMixCandidates call, unlike the real /api/ai-dj/mix route.
export async function simulateAiDjMix(segment: string, onProgress?: AiDjProgress, onLlm?: AiDjLlmCallback): Promise<AiDjMixResult> {
  const config = loadAiDjConfig();
  if (!config?.enabled) {
    return { ok: false, error: "AI DJ is not enabled in Settings" };
  }

  let csv: string;
  try {
    csv = csvTextForPlaylist(loadRunningPlaylistConfig().csvFile);
    if (!csv.trim()) throw new Error("empty library");
  } catch {
    return { ok: false, error: "No library CSV - upload a playlist library in Settings first" };
  }

  const easyBias = computeEasyPaceBias();
  const trackFeedback = getAllTrackVotes();
  const playCounts = getPlayCounts();
  const easyPaceSec = getLastEasyPaceSec() ?? undefined;
  const bpmOverrides = loadBpmOverrides();

  if (config.provider === "claude" || config.provider === "gemini") {
    const model = config.provider === "claude" ? config.claudeModel : config.geminiModel;
    const effort = config.provider === "claude" ? config.claudeEffort : undefined;
    return runBridge({
      title: "Simulation", segments: [segment], easyBias, trackFeedback,
      playedTracks: getPlayedTracks(), playCounts, bpmOverrides,
      easyPaceSec, model, effort, simulate: true,
    }, onProgress, onLlm);
  }

  const body = JSON.stringify({
    title: "Simulation", segments: [segment], csv, cadenceBuckets: loadCadenceBuckets(), easyBias, trackFeedback,
    playedTracks: getPlayedTracks(), playCounts, bpmOverrides,
    easyPace: easyPaceSec != null ? `${Math.floor(easyPaceSec / 60)}:${String(Math.round(easyPaceSec % 60)).padStart(2, "0")}` : undefined,
    simulate: true,
    model: config.ollamaModel || undefined,
  });
  const streamed = await fetchMixStream(config.url, body, onProgress ?? (() => {}), "/mix/stream", onLlm);
  if (streamed) return streamed;
  return { ok: false, error: `AI DJ service unreachable at ${config.url}` };
}

export interface OllamaModelInfo {
  name: string;
  sizeBytes: number | null;
  capabilities: string[];
}

// Lists installed Ollama models on the remote AI DJ service host (the
// Windows PC — Ollama doesn't run on the Pi this app lives on), for the
// Settings -> LLM Testing tab's model picker.
export async function listOllamaModels(): Promise<{ ok: true; models: OllamaModelInfo[] } | { ok: false; error: string }> {
  const config = loadAiDjConfig();
  if (!config?.url) return { ok: false, error: "AI DJ service URL not configured in Settings" };
  try {
    const res = await fetch(`${config.url}/models`, { signal: AbortSignal.timeout(10_000) });
    const data = await res.json() as { models?: OllamaModelInfo[]; error?: string };
    if (data.error) return { ok: false, error: data.error };
    return { ok: true, models: data.models ?? [] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach AI DJ service" };
  }
}

// Transcribes a PacePro split-table screenshot into pace-pro.csv's own CSV
// shape via a vision-capable Ollama model on the AI DJ service host — the
// caller (Settings -> Pace Pro) is responsible for checking that model's
// "vision" capability via listOllamaModels() first, since a non-vision
// model errors clearly server-side but the UI should never let the user
// attempt it in the first place. Defaults to config.ollamaModel, same
// model choice as a real mix build, since the whole point of switching it
// to a vision-capable model in Settings is that this feature also uses it.
export async function transcribePaceProImage(imageBase64: string): Promise<{ ok: true; csv: string } | { ok: false; error: string }> {
  const config = loadAiDjConfig();
  if (!config?.url) return { ok: false, error: "AI DJ service URL not configured in Settings" };
  try {
    const res = await fetch(`${config.url}/vision-transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64, model: config.ollamaModel || undefined }),
      signal: AbortSignal.timeout(150_000),
    });
    const data = await res.json() as { csv?: string; error?: string };
    if (!res.ok || data.error) return { ok: false, error: data.error ?? `AI DJ service ${res.status}` };
    if (!data.csv) return { ok: false, error: "No csv returned" };
    return { ok: true, csv: data.csv };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach AI DJ service" };
  }
}

// Same OCR pathway as transcribePaceProImage, but for the Runna schedule
// card's race-splits table (split #, split distance, split pace,
// cumulative distance, cumulative avg pace, elevation change — all 6
// columns, unlike Pace Pro's own OCR which deliberately drops elevation/
// cumulative). Calls a separate AI_DJ service endpoint
// (/vision-transcribe-race-splits) with its own tailored vision prompt,
// returning tab-separated text in the exact shape
// lib/race-splits.ts's parsePastedSplits already parses.
export async function transcribeRaceSplitsImage(imageBase64: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const config = loadAiDjConfig();
  if (!config?.url) return { ok: false, error: "AI DJ service URL not configured in Settings" };
  try {
    const res = await fetch(`${config.url}/vision-transcribe-race-splits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64, model: config.ollamaModel || undefined }),
      signal: AbortSignal.timeout(150_000),
    });
    const data = await res.json() as { text?: string; error?: string };
    if (!res.ok || data.error) return { ok: false, error: data.error ?? `AI DJ service ${res.status}` };
    if (!data.text) return { ok: false, error: "No text returned" };
    return { ok: true, text: data.text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach AI DJ service" };
  }
}

export interface OllamaModelStatus {
  name: string;
  sizeBytes: number;
  gpuPercent: number;
  cpuPercent: number;
}

// Live GPU/CPU offload for whatever model Ollama currently has loaded on the
// remote service host — polled by the LLM Testing tab while a comparison
// run is in flight, same numbers `ollama ps` reports.
export async function getOllamaModelStatus(): Promise<{ ok: true; models: OllamaModelStatus[] } | { ok: false; error: string }> {
  const config = loadAiDjConfig();
  if (!config?.url) return { ok: false, error: "AI DJ service URL not configured in Settings" };
  try {
    const res = await fetch(`${config.url}/model-status`, { signal: AbortSignal.timeout(10_000) });
    const data = await res.json() as { models?: OllamaModelStatus[]; error?: string };
    if (data.error) return { ok: false, error: data.error };
    return { ok: true, models: data.models ?? [] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach AI DJ service" };
  }
}

export interface ModelCompareResult {
  model: string;
  ok: boolean;
  error?: string;
  tookMs?: number;
  mix?: AiDjMixResponse;
}

// Runs the SAME workout through the real production pipeline once per
// model in `models`, sequentially (so each gets an uncontended GPU and the
// per-call timing is meaningful) — the Settings -> LLM Testing tab's
// side-by-side comparison. Only ever targets the remote Ollama service
// (config.provider === "local"'s codepath): Claude/Gemini already have
// their own model pickers elsewhere in Settings and don't need this
// multi-model sweep. Never persists anything, same as simulateAiDjMix.
export async function compareAiDjModels(
  segments: string[], models: string[],
  onModelStart?: (model: string, index: number, total: number) => void,
  onProgress?: AiDjProgress,
): Promise<ModelCompareResult[]> {
  const config = loadAiDjConfig();
  if (!config?.url) {
    return models.map(model => ({ model, ok: false, error: "AI DJ service URL not configured in Settings" }));
  }

  let csv: string;
  try {
    csv = csvTextForPlaylist(loadRunningPlaylistConfig().csvFile);
    if (!csv.trim()) throw new Error("empty library");
  } catch {
    return models.map(model => ({ model, ok: false, error: "No library CSV - upload a playlist library in Settings first" }));
  }

  const easyBias = computeEasyPaceBias();
  const trackFeedback = getAllTrackVotes();
  const playCounts = getPlayCounts();
  const easyPaceSec = getLastEasyPaceSec() ?? undefined;
  const bpmOverrides = loadBpmOverrides();
  const cadenceBuckets = loadCadenceBuckets();
  const playedTracks = getPlayedTracks();
  const easyPace = easyPaceSec != null ? `${Math.floor(easyPaceSec / 60)}:${String(Math.round(easyPaceSec % 60)).padStart(2, "0")}` : undefined;

  const results: ModelCompareResult[] = [];
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    onModelStart?.(model, i, models.length);
    const body = JSON.stringify({
      title: "Model comparison", segments, csv, cadenceBuckets, easyBias, trackFeedback,
      playedTracks, playCounts, bpmOverrides, easyPace, model,
    });
    const start = Date.now();
    try {
      const streamed = await fetchMixStream(config.url, body, onProgress ?? (() => {}), "/mix/stream");
      const tookMs = Date.now() - start;
      if (streamed?.ok) {
        results.push({ model, ok: true, tookMs, mix: streamed.mix });
      } else {
        results.push({ model, ok: false, tookMs, error: streamed?.ok === false ? streamed.error : "AI DJ service unreachable" });
      }
    } catch (err) {
      results.push({ model, ok: false, tookMs: Date.now() - start, error: err instanceof Error ? err.message : "Comparison failed" });
    }
  }
  return results;
}

function buildMixLocally(
  segments: string[], easyBias = 0, trackFeedback: object[] = [], playCounts: Record<string, number> = {}, onProgress?: AiDjProgress, avoidUris?: string[],
  model?: string, effort?: string, strictPaceTolerance?: boolean, segmentCandidateUris?: (string[] | null)[],
): Promise<AiDjMixResult> {
  return runBridge({
    segments, easyBias, trackFeedback,
    playedTracks: getPlayedTracks(), playCounts, bpmOverrides: loadBpmOverrides(),
    avoidTracks: avoidUris?.length ? avoidUris : undefined,
    easyPaceSec: getLastEasyPaceSec() ?? undefined,
    model, effort, strictPaceTolerance, segmentCandidateUris,
  }, onProgress);
}

function buildFlowMixLocally(
  title: string, trackUris: string[], trackFeedback: object[] = [], onProgress?: AiDjProgress,
  model?: string, effort?: string, durationSec?: number,
): Promise<AiDjMixResult> {
  return runBridge({
    title, trackUris, trackFeedback, playCounts: getPlayCounts(), model, effort, durationSec,
  }, onProgress);
}

// Sequences a fixed track pool (e.g. every track in a selected HR zone) for
// smooth transitions, instead of picking tracks to fit workout segments —
// BPM/energy act only as a local smoothness guide between neighbouring
// tracks, never a target. See ai_dj/workout.py's build_flow_mix.
// durationSec: trims the flow-ordered list to this length (e.g. the next
// scheduled run's estimated duration) instead of including every track.
export async function buildAiDjFlowMix(title: string, trackUris: string[], onProgress?: AiDjProgress, durationSec?: number): Promise<AiDjMixResult> {
  const config = loadAiDjConfig();
  if (!config?.enabled) {
    return { ok: false, error: "AI DJ is not enabled in Settings" };
  }
  if (!trackUris?.length) {
    return { ok: false, error: "No tracks to mix" };
  }

  let csv: string;
  try {
    csv = csvTextForPlaylist(loadRunningPlaylistConfig().csvFile);
    if (!csv.trim()) throw new Error("empty library");
  } catch {
    return { ok: false, error: "No library CSV - upload a playlist library in Settings first" };
  }

  const trackFeedback = getAllTrackVotes();

  if (config.provider === "claude") {
    return buildFlowMixLocally(title, trackUris, trackFeedback, onProgress, config.claudeModel, config.claudeEffort, durationSec);
  }
  if (config.provider === "gemini") {
    return buildFlowMixLocally(title, trackUris, trackFeedback, onProgress, config.geminiModel, undefined, durationSec);
  }

  const body = JSON.stringify({
    title, trackUris, csv, trackFeedback, playCounts: getPlayCounts(), durationSec,
    model: config.ollamaModel || undefined,
  });
  try {
    if (onProgress) {
      const streamed = await fetchMixStream(config.url, body, onProgress, "/flow-mix/stream");
      if (streamed) return streamed;
    }
    const res = await fetch(`${config.url}/flow-mix`, {
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
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ai-dj] remote service failed (${msg}) — trying on-Pi fallback`);
    const local = await buildFlowMixLocally(title, trackUris, trackFeedback, onProgress, undefined, undefined, durationSec);
    if (local.ok) return local;
    const hint = /timeout|abort/i.test(msg)
      ? "AI DJ service timed out"
      : `AI DJ service unreachable at ${config.url}`;
    return { ok: false, error: `${hint} — on-Pi fallback also failed: ${local.error}` };
  }
}
