import fs from "fs";
import path from "path";

const FILE = path.join(process.cwd(), "ntfy-config.json");

export function loadNtfyTopic(): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf-8")) as { topic?: string };
    return data?.topic ?? null;
  } catch {
    return null;
  }
}

export function saveNtfyTopic(topic: string): void {
  fs.writeFileSync(FILE, JSON.stringify({ topic }), "utf-8");
}
