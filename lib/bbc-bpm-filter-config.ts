import { getDb } from "@/lib/db";

// Global on/off switch for dropping BBC-imported tracks whose BPM falls
// outside the library's zone coverage (see lib/bbc-bpm-filter.ts). Applies
// to both the manual BBC card flow and the weekly cron.

const KEY = "bbc_bpm_filter";

export function getBbcBpmFilterEnabled(): boolean {
  const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
  if (!row) return false;
  try {
    const data = JSON.parse(row.value_json) as { enabled?: boolean };
    return data.enabled ?? false;
  } catch {
    return false;
  }
}

export function setBbcBpmFilterEnabled(enabled: boolean): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify({ enabled }));
}
