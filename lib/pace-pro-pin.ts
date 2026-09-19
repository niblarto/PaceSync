import { getDb } from "@/lib/db";
import type { AiDjMixResponse } from "@/lib/ai-dj-mix";

// The single most-recently-built Pace Pro mix, pinned server-side so it
// survives a page reload/different browser — unlike a real scheduled
// workout's pinned mix (lib/pinned-mixes.ts, keyed by date+title), a Pace
// Pro mix has no natural date to key by: it's an ad-hoc upload, one at a
// time, replaced wholesale by the next build. A single kv_config row is
// enough (same pattern as ai_dj_config/garmin_config).

const KEY = "pace_pro_pin";

export interface PaceProPin {
  title: string;
  totalSec: number;
  timeline: AiDjMixResponse["timeline"];
  splitsCsvText: string; // the original uploaded CSV, re-shown on reload
  fileName: string | null;
  pinnedAt: string; // ISO timestamp
}

export function getPaceProPin(): PaceProPin | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value_json) as PaceProPin;
  } catch {
    return null;
  }
}

export function setPaceProPin(pin: PaceProPin): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(pin));
}

export function removePaceProPin(): void {
  getDb().prepare("DELETE FROM kv_config WHERE key = ?").run(KEY);
}
