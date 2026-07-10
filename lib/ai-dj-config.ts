import fs from "fs";
import path from "path";

const FILE = path.join(process.cwd(), "ai-dj-config.json");

// "local" runs the AI DJ service's Ollama model; "claude" calls the Claude
// API from that same service (it holds the ANTHROPIC key, not this Pi).
export type AiDjProvider = "local" | "claude";
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5";
export const DEFAULT_CLAUDE_EFFORT = "medium";

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
}

export function loadAiDjConfig(): AiDjConfig | null {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf-8")) as AiDjConfig;
    if (data?.url) {
      return {
        url: data.url, enabled: !!data.enabled, autoPlaylist: data.autoPlaylist !== false, wolMac: data.wolMac ?? "",
        provider: data.provider === "claude" ? "claude" : "local",
        claudeModel: data.claudeModel || DEFAULT_CLAUDE_MODEL,
        claudeEffort: data.claudeEffort || DEFAULT_CLAUDE_EFFORT,
      };
    }
  } catch {}
  return null;
}

export function saveAiDjConfig(config: AiDjConfig): void {
  fs.writeFileSync(FILE, JSON.stringify(config), "utf-8");
}
