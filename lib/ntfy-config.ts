import { getDb } from "@/lib/db";

const KEY = "ntfy_config";

export function loadNtfyTopic(): string | null {
  const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
  if (!row) return null;
  try {
    const data = JSON.parse(row.value_json) as { topic?: string };
    return data?.topic ?? null;
  } catch {
    return null;
  }
}

export function saveNtfyTopic(topic: string): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify({ topic }));
}
