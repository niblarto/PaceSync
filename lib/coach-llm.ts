import { join } from "path";
import { spawn } from "child_process";
import { loadAiDjConfig } from "@/lib/ai-dj-config";
import { coachModelLabel, loadCoachConfig, type CoachConfig } from "@/lib/coach-config";
import { loadOllamaWebKey, ollamaWebSearch, webResultsBlock } from "@/lib/web-search";

export interface CoachMessage {
  role: "user" | "assistant";
  content: string;
}

export interface WebSource { title: string; url: string }

// `model` is the label of the AI that actually answered (it differs from the
// Settings choice when the local model stepped in for Claude/Gemini).
export type CoachReply =
  | { ok: true; reply: string; model: string; sources?: WebSource[]; note?: string }
  | { ok: false; error: string };

const PYTHON = process.platform === "win32" ? "python" : "python3";
const BRIDGE_TIMEOUT_MS = 260_000;
const LOCAL_TIMEOUT_MS = 300_000;
const LOCAL_THINK_TIMEOUT_MS = 900_000;

// Claude/Gemini "you've used your allowance" errors: free-tier quota, rate
// limits, or no credit left. These are the ones the local model can cover.
const LIMIT_RE = /\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit|too many requests|credit balance/i;

function localLabel(config: CoachConfig): string {
  return `Local · ${config.ollamaModel || "service default"}`;
}

// The local model on the AI DJ service PC.
async function localChat(config: CoachConfig, system: string, messages: CoachMessage[], think: boolean): Promise<CoachReply> {
  const dj = loadAiDjConfig();
  if (!dj?.url) return { ok: false, error: "The local model runs on the AI DJ service PC — set its URL in Settings → AI DJ" };
  try {
    const res = await fetch(`${dj.url}/coach/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system, messages, model: config.ollamaModel || undefined, think }),
      signal: AbortSignal.timeout(think ? LOCAL_THINK_TIMEOUT_MS : LOCAL_TIMEOUT_MS),
    });
    if (res.status === 404) return { ok: false, error: "The AI DJ service on the PC needs restarting to pick up the Coach" };
    const data = await res.json() as { reply?: string; error?: string };
    if (!res.ok || !data.reply) return { ok: false, error: data.error ?? `AI DJ service ${res.status}` };
    return { ok: true, reply: data.reply, model: localLabel(config) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: /timeout|abort/i.test(msg)
        ? "The local model took too long to reply"
        : "The PC running the local model isn't reachable — is it switched on? (Or pick Claude/Gemini in Settings → Coach.)",
    };
  }
}

// Claude/Gemini on the Pi (scripts/coach_bridge.py, same API keys and usage
// counters as the AI DJ).
function bridge(payload: Record<string, unknown>): Promise<{ ok: true; reply: string; sources?: WebSource[] } | { ok: false; error: string }> {
  return new Promise(resolve => {
    const proc = spawn(PYTHON, [join(process.cwd(), "scripts", "coach_bridge.py")]);
    const timer = setTimeout(() => proc.kill(), BRIDGE_TIMEOUT_MS);
    let out = "";
    let errTail = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { errTail = (errTail + d.toString()).slice(-800); });
    proc.on("close", code => {
      clearTimeout(timer);
      const last = out.trim().split("\n").pop() ?? "";
      try {
        const data = JSON.parse(last) as { reply?: string; sources?: WebSource[]; error?: string };
        if (data.reply) resolve({ ok: true, reply: data.reply, sources: data.sources });
        else resolve({ ok: false, error: data.error ?? `coach bridge exited ${code}` });
      } catch {
        resolve({ ok: false, error: errTail.trim().split("\n").pop() || `coach bridge exited ${code}` });
      }
    });
    proc.on("error", e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

// One coach reply from whichever AI Settings → Coach picked. If Claude/Gemini
// has hit its limit and "fall back to local" is on, the local model answers
// instead. opts.think: let the local model reason first (reports; slower but
// careful with numbers). Chat stays fast.
export async function coachChat(system: string, messages: CoachMessage[], opts: { think?: boolean } = {}): Promise<CoachReply> {
  const config = loadCoachConfig();
  if (config.provider === "local") return localChat(config, system, messages, !!opts.think);

  const model = config.provider === "claude" ? config.claudeModel : config.geminiModel;
  const effort = config.provider === "claude" ? config.claudeEffort : undefined;
  const r = await bridge({ system, messages, model, effort });
  if (r.ok) return { ok: true, reply: r.reply, model: coachModelLabel(config) };
  if (config.fallbackToLocal && LIMIT_RE.test(r.error)) {
    const local = await localChat(config, system, messages, !!opts.think);
    const who = config.provider === "claude" ? "Claude" : "Gemini";
    if (local.ok) return { ...local, model: `${local.model} (${who} limit reached)`, note: `${who} limit reached` };
    return { ok: false, error: `${who} limit reached, and the local model couldn't answer either: ${local.error}` };
  }
  return r;
}

// The Coach's 🌐 button. With an Ollama web search key saved: search the web
// for the question, then the usual coach AI (Settings → Coach, with its
// fallback) answers from the results plus the training data. Without a key:
// Gemini with Google Search (needs a paid Gemini key).
export async function coachWebChat(system: string, messages: CoachMessage[]): Promise<CoachReply> {
  const config = loadCoachConfig();
  if (loadOllamaWebKey()) {
    const question = [...messages].reverse().find(m => m.role === "user")?.content ?? "";
    const search = await ollamaWebSearch(question);
    if (!search.ok) return { ok: false, error: `Web search failed: ${search.error}` };
    const r = await coachChat(system + webResultsBlock(search.results), messages);
    if (!r.ok) return r;
    return { ...r, model: `${r.model} · 🌐 web`, sources: search.results.map(x => ({ title: x.title, url: x.url })) };
  }

  const webSystem = `${system}

### WEB SEARCH
You can search the web (Google Search) for this answer. Use it for evidence and specifics the training data can't give you, prefer reputable sources (sports-nutrition and sports-science bodies, peer-reviewed research, governing bodies) over blogs, and tie what you find back to this athlete's own numbers above.`;
  const r = await bridge({ system: webSystem, messages, model: config.geminiModel, web: true });
  if (r.ok) return { ok: true, reply: r.reply, sources: r.sources ?? [], model: `Gemini · ${config.geminiModel} · 🌐 web` };
  if (config.fallbackToLocal && LIMIT_RE.test(r.error)) {
    const local = await localChat(config, system, messages, false);
    if (local.ok) {
      return { ...local, model: `${local.model} (Gemini limit reached, no web search)`, note: "Gemini's limit is reached, so this was answered by the local model without searching the web." };
    }
    return { ok: false, error: `Gemini's limit is reached and the local model couldn't answer either: ${local.error}` };
  }
  return { ok: false, error: `Web search failed: ${r.error}` };
}
