import { getDb } from "@/lib/db";

// Nights the Health page ignores (right-click a night → Ignore this night), e.g. when the watch was taken off in the
// night so the readings don't reflect reality. An ignored night is left out of the averages, the headline figures and
// the AI summary, and shown faded on the chart. Dates are the morning you woke (YYYY-MM-DD), as the page files sleep.
const KEY = "health_ignored_dates";

export function loadIgnoredDates(): string[] {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    const v = row ? JSON.parse(row.value_json) as unknown : [];
    return Array.isArray(v) ? v.filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
  } catch {
    return [];
  }
}

export function setNightIgnored(date: string, ignored: boolean): string[] {
  const set = new Set(loadIgnoredDates());
  if (ignored) set.add(date); else set.delete(date);
  const dates = Array.from(set).sort();
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(dates));
  return dates;
}
