import { getDb } from "@/lib/db";

const KEY = "runna_config";

export function loadRunnaUrl(): string | null {
  const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
  if (!row) return null;
  try {
    const data = JSON.parse(row.value_json) as { icsUrl?: string };
    return data?.icsUrl ?? null;
  } catch {
    return null;
  }
}

export function saveRunnaUrl(icsUrl: string): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify({ icsUrl }));
}
