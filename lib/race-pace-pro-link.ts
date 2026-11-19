import { getDb } from "@/lib/db";

// Which saved Pace Pro mix is pinned to a race on the schedule (by date + workout title), so the race card can show
// that mix's tracklist whether or not the mix has a route attached. One kv_config row per race.

const key = (date: string, title: string) => `race_pace_pro_mix:${date}|${title}`;

export function getRacePaceProMixId(date: string, title: string): string | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(key(date, title)) as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as { mixId: string }).mixId : null;
  } catch {
    return null;
  }
}

export function setRacePaceProMixId(date: string, title: string, mixId: string): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(key(date, title), JSON.stringify({ mixId }));
}

export function removeRacePaceProMixId(date: string, title: string): void {
  getDb().prepare("DELETE FROM kv_config WHERE key = ?").run(key(date, title));
}
