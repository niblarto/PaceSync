import fs from "fs";
import path from "path";

const FILE = path.join(process.cwd(), "ai-dj-config.json");

export interface AiDjConfig {
  url: string;      // e.g. http://192.168.1.50:8765
  enabled: boolean;
}

export function loadAiDjConfig(): AiDjConfig | null {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf-8")) as AiDjConfig;
    if (data?.url) return { url: data.url, enabled: !!data.enabled };
  } catch {}
  return null;
}

export function saveAiDjConfig(config: AiDjConfig): void {
  fs.writeFileSync(FILE, JSON.stringify(config), "utf-8");
}
