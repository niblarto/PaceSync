import { join } from "path";
import { spawn } from "child_process";
import { loadAiDjConfig } from "@/lib/ai-dj-config";
import { loadCoachConfig } from "@/lib/coach-config";

export interface CoachMessage {
  role: "user" | "assistant";
  content: string;
}

export type CoachReply = { ok: true; reply: string } | { ok: false; error: string };

const PYTHON = process.platform === "win32" ? "python" : "python3";
const BRIDGE_TIMEOUT_MS = 260_000;
const LOCAL_TIMEOUT_MS = 300_000;

// One coach reply from whichever AI Settings -> Coach picked. Claude and
// Gemini run on the Pi (scripts/coach_bridge.py, same API keys and usage
// counters as the AI DJ); the local model runs on the AI DJ service PC.
export async function coachChat(system: string, messages: CoachMessage[]): Promise<CoachReply> {
  const config = loadCoachConfig();

  if (config.provider === "local") {
    const dj = loadAiDjConfig();
    if (!dj?.url) return { ok: false, error: "The local model runs on the AI DJ service PC — set its URL in Settings → AI DJ" };
    try {
      const res = await fetch(`${dj.url}/coach/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system, messages, model: config.ollamaModel || undefined }),
        signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
      });
      if (res.status === 404) return { ok: false, error: "The AI DJ service on the PC needs restarting to pick up the Coach" };
      const data = await res.json() as { reply?: string; error?: string };
      if (!res.ok || !data.reply) return { ok: false, error: data.error ?? `AI DJ service ${res.status}` };
      return { ok: true, reply: data.reply };
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

  const model = config.provider === "claude" ? config.claudeModel : config.geminiModel;
  const effort = config.provider === "claude" ? config.claudeEffort : undefined;
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
        const data = JSON.parse(last) as { reply?: string; error?: string };
        if (data.reply) resolve({ ok: true, reply: data.reply });
        else resolve({ ok: false, error: data.error ?? `coach bridge exited ${code}` });
      } catch {
        resolve({ ok: false, error: errTail.trim().split("\n").pop() || `coach bridge exited ${code}` });
      }
    });
    proc.on("error", e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    proc.stdin.write(JSON.stringify({ system, messages, model, effort }));
    proc.stdin.end();
  });
}
