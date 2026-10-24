import { garminConnectGet } from "@/lib/garmin-weight";

// Garmin's Training Readiness (score 1-100, level, what it advises, and what
// drives it). Not in the Personal API, so it comes from Garmin Connect's own
// metrics endpoint with the sign-in GarminDB keeps. Garmin updates it several
// times a day (after waking, after a run, as the day goes on); the latest
// reading is the current one.

interface RawReading {
  calendarDate: string;
  timestampLocal: string;
  level: string;
  feedbackShort: string;
  feedbackLong?: string;
  score: number;
  sleepScore?: number | null;
  recoveryTime?: number | null; // minutes
  hrvWeeklyAverage?: number | null;
  acuteLoad?: number | null;
  inputContext?: string | null;
  sleepScoreFactorFeedback?: string; recoveryTimeFactorFeedback?: string; acwrFactorFeedback?: string;
  stressHistoryFactorFeedback?: string; hrvFactorFeedback?: string; sleepHistoryFactorFeedback?: string;
}

export interface TrainingReadiness {
  date: string; // the day the reading is for
  at: string; // local time it was taken, ISO-ish
  score: number;
  level: string; // "Poor" | "Low" | "Moderate" | "High" | "Prime"
  advice: string; // e.g. "Time to recharge"
  recoveryHours: number | null;
  sleepScore: number | null;
  hrv: number | null; // weekly average, ms
  acuteLoad: number | null;
  factors: { name: string; feedback: string }[];
}

// "TIME_TO_RECHARGE" -> "Time to recharge"
function pretty(code: string | undefined): string {
  const t = (code ?? "").toLowerCase().replace(/_/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let cache: { at: number; value: TrainingReadiness | null } | null = null;
const CACHE_MS = 10 * 60_000;

async function readingFor(date: string): Promise<{ ok: true; reading: RawReading | null } | { ok: false; error: string }> {
  const r = await garminConnectGet<RawReading[]>(`/metrics-service/metrics/trainingreadiness/${date}`);
  if (!r.ok) return r;
  const list = Array.isArray(r.data) ? r.data : [];
  const latest = list.slice().sort((a, b) => a.timestampLocal.localeCompare(b.timestampLocal)).pop();
  return { ok: true, reading: latest ?? null };
}

// The latest reading: today's, or yesterday's last if Garmin hasn't made one today yet.
export async function getTrainingReadiness(): Promise<{ ok: true; readiness: TrainingReadiness | null } | { ok: false; error: string }> {
  if (cache && Date.now() - cache.at < CACHE_MS) return { ok: true, readiness: cache.value };
  const now = new Date();
  let res = await readingFor(ymd(now));
  if (res.ok && !res.reading) res = await readingFor(ymd(new Date(now.getTime() - 86_400_000)));
  if (!res.ok) return res;
  const raw = res.reading;
  const value: TrainingReadiness | null = raw
    ? {
        date: raw.calendarDate,
        at: raw.timestampLocal,
        score: raw.score,
        level: pretty(raw.level),
        advice: pretty(raw.feedbackShort),
        recoveryHours: raw.recoveryTime != null ? Math.round(raw.recoveryTime / 60) : null,
        sleepScore: raw.sleepScore ?? null,
        hrv: raw.hrvWeeklyAverage ?? null,
        acuteLoad: raw.acuteLoad ?? null,
        factors: ([
          ["Sleep", raw.sleepScoreFactorFeedback], ["Recovery time", raw.recoveryTimeFactorFeedback],
          ["Training load", raw.acwrFactorFeedback], ["Stress history", raw.stressHistoryFactorFeedback],
          ["HRV", raw.hrvFactorFeedback], ["Sleep history", raw.sleepHistoryFactorFeedback],
        ] as [string, string | undefined][]).filter(([, f]) => f).map(([name, f]) => ({ name, feedback: pretty(f) })),
      }
    : null;
  cache = { at: Date.now(), value };
  return { ok: true, readiness: value };
}
