import { garminApiGet } from "@/lib/garmin-personal-api";

// Today's Body Battery, from the Garmin Personal API's daily summary: the current
// value, what it was on waking, the day's high and low, and what has charged and
// drained so far.

interface RawSummary {
  bodyBatteryMostRecentValue?: number | null;
  bodyBatteryAtWakeTime?: number | null;
  bodyBatteryHighestValue?: number | null;
  bodyBatteryLowestValue?: number | null;
  bodyBatteryChargedValue?: number | null;
  bodyBatteryDrainedValue?: number | null;
}

export interface BodyBattery {
  date: string;
  current: number | null;
  atWake: number | null;
  high: number | null;
  low: number | null;
  charged: number | null;
  drained: number | null;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let cache: { at: number; date: string; value: BodyBattery | null } | null = null;
const CACHE_MS = 5 * 60_000;

export async function getBodyBattery(): Promise<BodyBattery | null> {
  const date = ymd(new Date());
  if (cache && cache.date === date && Date.now() - cache.at < CACHE_MS) return cache.value;
  const s = await garminApiGet<RawSummary>(`/usersummary-service/usersummary/daily?calendarDate=${date}`);
  const value: BodyBattery | null = s.bodyBatteryMostRecentValue == null
    ? null
    : {
        date,
        current: s.bodyBatteryMostRecentValue ?? null,
        atWake: s.bodyBatteryAtWakeTime ?? null,
        high: s.bodyBatteryHighestValue ?? null,
        low: s.bodyBatteryLowestValue ?? null,
        charged: s.bodyBatteryChargedValue ?? null,
        drained: s.bodyBatteryDrainedValue ?? null,
      };
  cache = { at: Date.now(), date, value };
  return value;
}
