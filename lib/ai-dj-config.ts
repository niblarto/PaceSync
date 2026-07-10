import fs from "fs";
import path from "path";

const FILE = path.join(process.cwd(), "ai-dj-config.json");

// "local" calls the separate Ollama-backed AI DJ service (needs that PC on);
// "claude"/"gemini" run scripts/ai_dj_bridge.py right here on the Pi against
// the respective hosted API — no dependency on the other PC.
export type AiDjProvider = "local" | "claude" | "gemini";
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5";
export const DEFAULT_CLAUDE_EFFORT = "medium";
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

export interface AiDjConfig {
  url: string;      // e.g. http://192.168.1.50:8765
  enabled: boolean;
  // Daily 15:30 cron pre-builds tomorrow's mix into "Today's Run" (on by default).
  autoPlaylist: boolean;
  // MAC of the AI DJ service host, for Wake-on-LAN from the settings page.
  wolMac?: string;
  provider: AiDjProvider;
  claudeModel: string;   // e.g. "claude-sonnet-5" — see ai_dj/llm.py CLAUDE_MODELS
  claudeEffort: string;  // low | medium | high | xhigh | max
  geminiModel: string;   // e.g. "gemini-2.5-flash" — see ai_dj/llm.py GEMINI_MODELS
}

export function loadAiDjConfig(): AiDjConfig | null {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf-8")) as AiDjConfig;
    if (data?.url) {
      return {
        url: data.url, enabled: !!data.enabled, autoPlaylist: data.autoPlaylist !== false, wolMac: data.wolMac ?? "",
        provider: data.provider === "claude" ? "claude" : data.provider === "gemini" ? "gemini" : "local",
        claudeModel: data.claudeModel || DEFAULT_CLAUDE_MODEL,
        claudeEffort: data.claudeEffort || DEFAULT_CLAUDE_EFFORT,
        geminiModel: data.geminiModel || DEFAULT_GEMINI_MODEL,
      };
    }
  } catch {}
  return null;
}

export function saveAiDjConfig(config: AiDjConfig): void {
  fs.writeFileSync(FILE, JSON.stringify(config), "utf-8");
}
