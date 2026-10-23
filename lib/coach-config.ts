import { getDb } from "@/lib/db";
import { loadAiDjConfig, currentGeminiModel, DEFAULT_CLAUDE_MODEL, DEFAULT_CLAUDE_EFFORT, type AiDjProvider } from "@/lib/ai-dj-config";

const KEY = "coach_config";

// The Coach's own AI choice — same three providers as the AI DJ, chosen
// separately (Settings -> Coach). "local" runs on the AI DJ service PC's
// Ollama, so it uses the AI DJ service URL.
export interface CoachConfig {
  provider: AiDjProvider;
  claudeModel: string;
  claudeEffort: string;
  geminiModel: string;
  ollamaModel: string; // "" = the AI DJ service's default model
  fallbackToLocal: boolean; // Claude/Gemini quota or rate limit hit → use the local model
}

export function loadCoachConfig(): CoachConfig {
  const dj = loadAiDjConfig();
  let data: Partial<CoachConfig> = {};
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    if (row) data = JSON.parse(row.value_json) as Partial<CoachConfig>;
  } catch {}
  // Until the Coach has its own setting, start from the AI DJ's choice.
  const provider = data.provider ?? dj?.provider ?? "local";
  return {
    provider: provider === "claude" || provider === "gemini" ? provider : "local",
    claudeModel: data.claudeModel || dj?.claudeModel || DEFAULT_CLAUDE_MODEL,
    claudeEffort: data.claudeEffort || dj?.claudeEffort || DEFAULT_CLAUDE_EFFORT,
    geminiModel: currentGeminiModel(data.geminiModel || dj?.geminiModel),
    ollamaModel: data.ollamaModel ?? dj?.ollamaModel ?? "",
    fallbackToLocal: data.fallbackToLocal ?? true,
  };
}

export function saveCoachConfig(config: CoachConfig): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(config));
}

export function coachModelLabel(c: CoachConfig): string {
  if (c.provider === "claude") return `Claude · ${c.claudeModel}`;
  if (c.provider === "gemini") return `Gemini · ${c.geminiModel}`;
  return `Local · ${c.ollamaModel || "service default"}`;
}
