import { getDb } from "@/lib/db";
import { garminConnectGet } from "@/lib/garmin-connect";

// Garmin's Sleep Coach: how much sleep it recommends for tonight (and what it was for last night), against your baseline
// need, why it has moved (today's and recent training load, recent short or poor sleep, HRV, a nap), and its own verdict
// on last night's sleep. Read from the same Garmin Connect sleep response as the Health page's sleep figures, with the
// sign-in GarminDB keeps. Unofficial, so it can change without notice. Cached 30 minutes.

export interface SleepNeed {
  forDate: string;          // the night the recommendation is for
  needMin: number;          // recommended sleep, minutes
  baselineMin: number;      // your usual need, minutes
  change: string | null;    // "Highly increased", "Increased", "No change", "Decreased"
  reasons: string[];        // what moved it: "today's and recent training load", "recent short sleep", …
}

export interface SleepCoach {
  date: string;             // the day the response was read for
  tonight: SleepNeed | null;
  lastNight: SleepNeed | null;
  verdict: string | null;   // Garmin's read on last night's sleep: "Short but deep"
  verdictTone: "good" | "fair" | "poor" | null;
  insight: string | null;   // e.g. "Restful day"
  actualMin: number | null; // last night's sleep, minutes
}

interface RawNeed {
  calendarDate?: string; baseline?: number; actual?: number; feedback?: string;
  trainingFeedback?: string; sleepHistoryAdjustment?: string; hrvAdjustment?: string; napAdjustment?: string;
}
interface RawSleep {
  dailySleepDTO?: {
    sleepTimeSeconds?: number | null; sleepScoreFeedback?: string | null; sleepScoreInsight?: string | null;
    sleepNeed?: RawNeed | null; nextSleepNeed?: RawNeed | null;
  } | null;
}

// "HIGHLY_INCREASED" → "Highly increased"
function pretty(code: string | null | undefined): string | null {
  const t = (code ?? "").toLowerCase().replace(/_/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : null;
}

const TRAINING: Record<string, string> = {
  TODAYS_LOAD: "today's training load", CHRONIC: "your recent training load", TODAYS_LOAD_AND_CHRONIC: "today's and recent training load",
};
const HISTORY: Record<string, string> = {
  INCREASING: "recent short sleep", INCREASING_LOW_QUALITY: "recent poor-quality sleep", DECREASING: "recent good sleep",
};

function need(n: RawNeed | null | undefined): SleepNeed | null {
  if (!n || typeof n.actual !== "number" || typeof n.baseline !== "number") return null;
  const reasons: string[] = [];
  if (n.trainingFeedback && n.trainingFeedback !== "NO_CHANGE") reasons.push(TRAINING[n.trainingFeedback] ?? pretty(n.trainingFeedback)!.toLowerCase());
  if (n.sleepHistoryAdjustment && n.sleepHistoryAdjustment !== "NO_CHANGE") reasons.push(HISTORY[n.sleepHistoryAdjustment] ?? pretty(n.sleepHistoryAdjustment)!.toLowerCase());
  if (n.hrvAdjustment && n.hrvAdjustment !== "NO_CHANGE") reasons.push("your HRV");
  if (n.napAdjustment && n.napAdjustment !== "NO_CHANGE") reasons.push("a nap");
  return { forDate: n.calendarDate ?? "", needMin: n.actual, baselineMin: n.baseline, change: pretty(n.feedback), reasons };
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const KEY = "garmin_sleep_coach";
const TTL_MS = 30 * 60_000;

function read(raw: RawSleep, date: string): SleepCoach | null {
  const dto = raw.dailySleepDTO;
  const tonight = need(dto?.nextSleepNeed), lastNight = need(dto?.sleepNeed);
  if (!dto || (!tonight && !lastNight)) return null;
  // "POSITIVE_SHORT_BUT_DEEP" → tone good, "Short but deep"; NEGATIVE_ → poor; anything else fair.
  const fb = dto.sleepScoreFeedback ?? "";
  const tone = /^POSITIVE/.test(fb) ? "good" : /^NEGATIVE/.test(fb) ? "poor" : fb ? "fair" : null;
  const strip = (s: string | null | undefined) => pretty((s ?? "").replace(/^(POSITIVE|NEGATIVE|NEUTRAL)_/, ""));
  return {
    date, tonight, lastNight, verdict: strip(dto.sleepScoreFeedback), verdictTone: tone, insight: strip(dto.sleepScoreInsight),
    actualMin: typeof dto.sleepTimeSeconds === "number" ? Math.round(dto.sleepTimeSeconds / 60) : null,
  };
}

// Today's sleep response (it carries tonight's recommendation); yesterday's if Garmin has nothing for today yet.
export async function getSleepCoach(): Promise<SleepCoach | null> {
  const cached = (() => {
    try {
      const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
      return row ? JSON.parse(row.value_json) as { at: number; date: string; data: SleepCoach | null } : null;
    } catch { return null; }
  })();
  const today = ymd(new Date());
  if (cached && cached.date === today && Date.now() - cached.at < TTL_MS) return cached.data;
  const yesterday = ymd(new Date(Date.now() - 86_400_000));
  let data: SleepCoach | null = null;
  try {
    for (const date of [today, yesterday]) {
      const raw = await garminConnectGet<RawSleep>(`/sleep-service/sleep/dailySleepData?date=${date}&nonSleepBufferMinutes=60`);
      data = read(raw, date);
      if (data) break;
    }
  } catch {
    return cached?.data ?? null;
  }
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify({ at: Date.now(), date: today, data }));
  return data;
}
