import fs from "fs";
import path from "path";

const CONFIG_FILE = path.join(process.cwd(), "garmin-config.json");

export interface GarminConfig {
  dbPath: string;
}

export function loadGarminConfig(): GarminConfig | null {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as GarminConfig;
    if (data.dbPath) return data;
  } catch {}
  return null;
}

export function saveGarminConfig(config: GarminConfig): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config), "utf-8");
}

export function deleteGarminConfig(): void {
  try { fs.unlinkSync(CONFIG_FILE); } catch {}
}
