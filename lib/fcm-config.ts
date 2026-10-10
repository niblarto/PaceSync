import { getDb } from "@/lib/db";

// Single-device FCM registration token for the Android companion app —
// mirrors lib/ntfy-config.ts's single-topic shape exactly (one user, one
// phone, same as the existing ntfy setup). A second device would need this
// to become a list; not needed yet.

const KEY = "fcm_config";

export function loadFcmToken(): string | null {
  const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
  if (!row) return null;
  try {
    const data = JSON.parse(row.value_json) as { token?: string };
    return data?.token ?? null;
  } catch {
    return null;
  }
}

export function saveFcmToken(token: string): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify({ token }));
}
