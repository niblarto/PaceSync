import { garminConnectGet } from "@/lib/garmin-connect";
import { getDb } from "@/lib/db";
import { buildNutritionDashboard } from "@/lib/nutrition-dashboard";

// The Metrics page's "Today" board: heart rate, stress, Body Battery, steps, breathing and SpO2 from midnight until now,
// read live from Garmin Connect (GarminDB only syncs once a night, so it has nothing for today), plus the headline gauge
// values. Times are epoch ms (real instants), so the browser shows them in its own time zone.

type Json = Record<string, unknown>;
export interface Pt { t: number; v: number }

export interface TrainingStatus {
  label: string | null;            // "Productive", "Strained"…
  acute: number | null; chronic: number | null; ratio: number | null; acwrStatus: string | null;
  tunnelMin: number | null; tunnelMax: number | null;   // the chronic-load range Garmin calls optimal
  vo2Max: number | null;
  balance: { aerobicLow: number; aerobicHigh: number; anaerobic: number; lowMin: number; lowMax: number; highMin: number; highMax: number; anMin: number; anMax: number; feedback: string | null } | null;
}
export interface RacePredictions {
  latest: { s5k: number; s10k: number; half: number; full: number; date: string } | null;
  history: { t: number; s5k: number; s10k: number; half: number; full: number }[]; // the 90 days up to the date, seconds
}

export interface HillScore {
  overall: number | null; strength: number | null; endurance: number | null;
  history: { t: number; overall: number; strength: number | null; endurance: number | null }[]; // last 90 days
}
export interface EnduranceScore {
  score: number | null; label: string | null;
  bands: { name: string; from: number }[];     // Garmin's classification thresholds, lowest first
  gaugeLower: number | null; gaugeUpper: number | null;
  history: { t: number; v: number }[];         // weekly average, last 90 days
}

export interface LactateThreshold {
  hr: number | null; speedMs: number | null; date: string | null;   // latest (speed in m/s)
  history: { t: number; hr: number | null; speedMs: number | null }[]; // each change in the last 90 days
}

export interface MetricsLive {
  date: string; now: number;
  hr: Pt[]; stress: Pt[]; bodyBattery: Pt[]; rr: Pt[]; spo2: Pt[];
  stepsCum: Pt[];                          // cumulative steps since midnight
  stepsHourly: Pt[];                       // steps in each hour (t = start of the hour, ms)
  gauges: { rhr: number | null; steps: number | null; spo2: number | null; sleepHours: number | null; stepGoal: number | null };
  trainingStatus: TrainingStatus | null;
  hillScore: HillScore | null;
  enduranceScore: EnduranceScore | null;
  lactate: LactateThreshold | null;
  racePredictions: RacePredictions | null;
  sleepStages: { start: number; end: number; stages: { start: number; end: number; stage: "deep" | "light" | "rem" | "awake" }[] } | null;
  weight: { kg: number; date: string; avg7Kg: number; postRun: boolean; targetKg: number | null; measuredAt: string | null } | null; // as on the Nutrition tab
  notes: string[];                         // what couldn't be read
}

const TTL_MS = 2 * 60_000;
const cache = new Map<string, { at: number; value: MetricsLive }>();
export function clearMetricsLiveCache(): void { cache.clear(); }

async function displayName(): Promise<string> {
  const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = 'garmin_display_name'").get() as { value_json: string } | undefined;
  if (row) { try { const v = JSON.parse(row.value_json); if (typeof v === "string" && v) return v; } catch {} }
  const p = await garminConnectGet<{ displayName: string }>("/userprofile-service/socialProfile");
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES ('garmin_display_name', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(JSON.stringify(p.displayName));
  return p.displayName;
}

// [[ms, value], ...] → points, dropping nulls and negatives (Garmin uses -1/-2 for "no reading").
function pairs(arr: unknown, valueIndex = 1, min = 0): Pt[] {
  if (!Array.isArray(arr)) return [];
  const out: Pt[] = [];
  for (const row of arr as unknown[]) {
    if (!Array.isArray(row)) continue;
    const t = Number(row[0]), v = Number(row[valueIndex]);
    if (Number.isFinite(t) && Number.isFinite(v) && v >= min) out.push({ t, v });
  }
  return out.sort((a, b) => a.t - b.t);
}

const gmt = (s: unknown): number => Date.parse(`${String(s).replace(" ", "T").replace(/Z$/, "")}Z`);

export async function buildMetricsLive(date: string, force = false): Promise<MetricsLive> {
  const hit = cache.get(date);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const out: MetricsLive = {
    date, now: Date.now(), hr: [], stress: [], bodyBattery: [], rr: [], spo2: [], stepsCum: [], stepsHourly: [],
    gauges: { rhr: null, steps: null, spo2: null, sleepHours: null, stepGoal: null }, trainingStatus: null, hillScore: null, enduranceScore: null, lactate: null, racePredictions: null, sleepStages: null, weight: null, notes: [],
  };

  // Current weight: the same reading the Nutrition tab shows (Garmin weigh-ins, post-run ones flagged).
  try {
    const n = buildNutritionDashboard(7);
    if (n.current) out.weight = { kg: n.current.kg, date: n.current.date, avg7Kg: n.current.avg7Kg, postRun: n.current.postRun, targetKg: n.config.targetWeightKg ?? null, measuredAt: n.current.measuredAt };
  } catch { /* no weight data yet */ }

  let dn: string;
  try { dn = await displayName(); } catch { out.notes.push("Couldn't reach Garmin Connect."); return out; }
  const get = async <T>(label: string, p: string): Promise<T | null> => {
    try { return await garminConnectGet<T>(p); } catch (e) { out.notes.push(`${label}: ${e instanceof Error ? e.message : "failed"}`); return null; }
  };

  const from90 = (() => { const d = new Date(`${date}T12:00:00`); d.setDate(d.getDate() - 90); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const [hr, stress, steps, rr, spo2, summary, sleep, tstat, tagg, races, hill, hillStats, endur, endurStats, ltLatest, ltSpeed, ltHr] = await Promise.all([
    get<Json>("Heart rate", `/wellness-service/wellness/dailyHeartRate/${encodeURIComponent(dn)}?date=${date}`),
    get<Json>("Stress", `/wellness-service/wellness/dailyStress/${date}`),
    get<Json[]>("Steps", `/wellness-service/wellness/dailySummaryChart/${encodeURIComponent(dn)}?date=${date}`),
    get<Json>("Breathing", `/wellness-service/wellness/daily/respiration/${date}`),
    get<Json>("SpO2", `/wellness-service/wellness/daily/spo2/${date}`),
    get<Json>("Summary", `/usersummary-service/usersummary/daily/${encodeURIComponent(dn)}?calendarDate=${date}`),
    get<{ dailySleepDTO?: { sleepTimeSeconds?: number; sleepStartTimestampGMT?: number; sleepEndTimestampGMT?: number }; sleepLevels?: { startGMT?: string | number; endGMT?: string | number; activityLevel?: number }[] }>("Sleep", `/sleep-service/sleep/dailySleepData?date=${date}&nonSleepBufferMinutes=60`),
    get<Json>("Training status", `/metrics-service/metrics/trainingstatus/daily/${date}`),
    get<Json>("Training balance", `/metrics-service/metrics/trainingstatus/aggregated/${date}`),
    get<Json[]>("Race predictions", `/metrics-service/metrics/racepredictions/daily/${encodeURIComponent(dn)}?fromCalendarDate=${from90}&toCalendarDate=${date}&_=1`),
    get<Json>("Hill score", `/metrics-service/metrics/hillscore?calendarDate=${date}`),
    get<Json>("Hill score history", `/metrics-service/metrics/hillscore/stats?startDate=${from90}&endDate=${date}&aggregation=daily`),
    get<Json>("Endurance score", `/metrics-service/metrics/endurancescore?calendarDate=${date}`),
    get<Json>("Endurance score history", `/metrics-service/metrics/endurancescore/stats?startDate=${from90}&endDate=${date}&aggregation=weekly`),
    get<Json[]>("Lactate threshold", `/biometric-service/biometric/latestLactateThreshold`),
    get<Json[]>("Lactate threshold speed", `/biometric-service/stats/lactateThresholdSpeed/range/${from90}/${date}?sport=RUNNING&aggregation=daily&aggregationStrategy=LATEST`),
    get<Json[]>("Lactate threshold HR", `/biometric-service/stats/lactateThresholdHeartRate/range/${from90}/${date}?sport=RUNNING&aggregation=daily&aggregationStrategy=LATEST`),
  ]);

  out.hr = pairs(hr?.heartRateValues, 1, 1);
  out.stress = pairs(stress?.stressValuesArray, 1, 0);
  // Body Battery in this response is [ms, status, level, version]
  out.bodyBattery = pairs(stress?.bodyBatteryValuesArray, 2, 0);
  out.rr = pairs(rr?.respirationValuesArray, 1, 1);
  out.spo2 = pairs(spo2?.spO2HourlyAverages ?? spo2?.spO2ValuesArray, 1, 1);

  // Steps come in 15-minute chunks (GMT start times); sum them up for the running total and the hourly strip.
  let run = 0;
  const hourly = new Map<number, number>();
  for (const c of (steps ?? []).slice().sort((a, b) => gmt(a.startGMT) - gmt(b.startGMT))) {
    const t = gmt(c.startGMT), n = Number(c.steps) || 0;
    if (!Number.isFinite(t)) continue;
    run += n;
    out.stepsCum.push({ t: t + 15 * 60_000, v: run });
    const h = Math.floor(t / 3600_000) * 3600_000;
    hourly.set(h, (hourly.get(h) ?? 0) + n);
  }
  out.stepsHourly = Array.from(hourly.entries()).sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));

  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  out.gauges.steps = num(summary?.totalSteps) ?? (run || null);
  out.gauges.stepGoal = num(summary?.dailyStepGoal);
  out.gauges.rhr = num(hr?.restingHeartRate) ?? num(summary?.restingHeartRate);
  out.gauges.spo2 = num(summary?.latestSpo2) ?? num(summary?.averageSpo2) ?? (out.spo2.length ? Math.round(out.spo2[out.spo2.length - 1].v) : null);
  const sleepSec = num(sleep?.dailySleepDTO?.sleepTimeSeconds);
  out.gauges.sleepHours = sleepSec ? Math.round(sleepSec / 360) / 10 : null;

  // Sleep stages of the night ending on this date: [deep, light, REM, awake] by activityLevel 0-3.
  const stageMs = (v: string | number | undefined) => (typeof v === "number" ? v : v ? gmt(v) : NaN);
  const stages = (sleep?.sleepLevels ?? []).flatMap(l => {
    const a = stageMs(l.startGMT), b = stageMs(l.endGMT), k = (["deep", "light", "rem", "awake"] as const)[l.activityLevel ?? -1];
    return Number.isFinite(a) && Number.isFinite(b) && k ? [{ start: a, end: b, stage: k }] : [];
  });
  if (stages.length) out.sleepStages = { start: sleep?.dailySleepDTO?.sleepStartTimestampGMT ?? stages[0].start, end: sleep?.dailySleepDTO?.sleepEndTimestampGMT ?? stages[stages.length - 1].end, stages };

  // Training status: Garmin's label, the acute / chronic load, VO2 max and the load balance.
  const latestStatus = (o: Json | null | undefined): Json | null => {
    const m = (o?.latestTrainingStatusData ?? null) as Record<string, Json> | null;
    if (!m) return null;
    const vals = Object.values(m);
    return vals.find(v => v.primaryTrainingDevice) ?? vals[0] ?? null;
  };
  const st = latestStatus(tstat) ?? latestStatus((tagg?.mostRecentTrainingStatus ?? null) as Json | null);
  if (st || tagg) {
    const acute = (st?.acuteTrainingLoadDTO ?? {}) as Json;
    const phrase = typeof st?.trainingStatusFeedbackPhrase === "string" ? st.trainingStatusFeedbackPhrase : null;
    const pretty = (x: string | null) => (x ? x.replace(/_\d+$/, "").toLowerCase().replace(/(^|_)(\w)/g, (_, a, c) => (a ? " " : "") + c.toUpperCase()).trim() : null);
    const vo2 = ((tagg?.mostRecentVO2Max ?? null) as Json | null)?.generic as Json | undefined;
    const bm = ((tagg?.mostRecentTrainingLoadBalance ?? null) as Json | null)?.metricsTrainingLoadBalanceDTOMap as Record<string, Json> | undefined;
    const b = bm ? (Object.values(bm).find(v => v.primaryTrainingDevice) ?? Object.values(bm)[0]) : null;
    out.trainingStatus = {
      label: pretty(phrase), acute: num(acute.dailyTrainingLoadAcute), chronic: num(acute.dailyTrainingLoadChronic), ratio: num(acute.dailyAcuteChronicWorkloadRatio),
      acwrStatus: typeof acute.acwrStatus === "string" ? pretty(acute.acwrStatus) : null,
      tunnelMin: num(acute.minTrainingLoadChronic), tunnelMax: num(acute.maxTrainingLoadChronic),
      vo2Max: num(vo2?.vo2MaxPreciseValue) ?? num(vo2?.vo2MaxValue),
      balance: b ? {
        aerobicLow: num(b.monthlyLoadAerobicLow) ?? 0, aerobicHigh: num(b.monthlyLoadAerobicHigh) ?? 0, anaerobic: num(b.monthlyLoadAnaerobic) ?? 0,
        lowMin: num(b.monthlyLoadAerobicLowTargetMin) ?? 0, lowMax: num(b.monthlyLoadAerobicLowTargetMax) ?? 0,
        highMin: num(b.monthlyLoadAerobicHighTargetMin) ?? 0, highMax: num(b.monthlyLoadAerobicHighTargetMax) ?? 0,
        anMin: num(b.monthlyLoadAnaerobicTargetMin) ?? 0, anMax: num(b.monthlyLoadAnaerobicTargetMax) ?? 0,
        feedback: typeof b.trainingBalanceFeedbackPhrase === "string" ? pretty(b.trainingBalanceFeedbackPhrase) : null,
      } : null,
    };
  }

  // Race predictions: the 90 days up to this date (seconds).
  const hist = (races ?? []).flatMap(r => {
    const t = Date.parse(`${String(r.calendarDate)}T12:00:00`);
    const a = num(r.time5K), b2 = num(r.time10K), c = num(r.timeHalfMarathon), d = num(r.timeMarathon);
    return Number.isFinite(t) && a && b2 && c && d ? [{ t, s5k: a, s10k: b2, half: c, full: d }] : [];
  }).sort((x, y) => x.t - y.t);
  if (hist.length) {
    const l = hist[hist.length - 1];
    out.racePredictions = { latest: { s5k: l.s5k, s10k: l.s10k, half: l.half, full: l.full, date: new Date(l.t).toISOString().slice(0, 10) }, history: hist };
  }

  // Hill score (overall, strength, endurance) and its daily history.
  const hillRows = ((hillStats?.hillScoreDTOList ?? []) as Json[]).flatMap(h => {
    const t = Date.parse(`${String(h.calendarDate)}T12:00:00`), o = num(h.overallScore);
    return Number.isFinite(t) && o != null ? [{ t, overall: o, strength: num(h.strengthScore), endurance: num(h.enduranceScore) }] : [];
  }).sort((a, b) => a.t - b.t);
  if (hill || hillRows.length) {
    out.hillScore = { overall: num(hill?.overallScore), strength: num(hill?.strengthScore), endurance: num(hill?.enduranceScore), history: hillRows };
  }

  // Endurance score: today's value, Garmin's classification bands, and the weekly average history.
  if (endur || endurStats) {
    const score = num(endur?.overallScore);
    const bands = ([["Recreational", null], ["Intermediate", "classificationLowerLimitIntermediate"], ["Trained", "classificationLowerLimitTrained"],
      ["Well Trained", "classificationLowerLimitWellTrained"], ["Expert", "classificationLowerLimitExpert"], ["Superior", "classificationLowerLimitSuperior"],
      ["Elite", "classificationLowerLimitElite"]] as [string, string | null][])
      .flatMap(([name, key]) => (key == null ? [{ name, from: num(endur?.gaugeLowerLimit) ?? 0 }] : num(endur?.[key]) != null ? [{ name, from: num(endur?.[key])! }] : []));
    const label = score != null && bands.length ? [...bands].reverse().find(b => score >= b.from)?.name ?? bands[0].name : null;
    const groups = (endurStats?.groupMap ?? {}) as Record<string, Json>;
    const hist = Object.entries(groups).flatMap(([k, g]) => {
      const t = Date.parse(`${k}T12:00:00`), v = num(g.groupAverage);
      return Number.isFinite(t) && v != null ? [{ t, v }] : [];
    }).sort((a, b) => a.t - b.t);
    out.enduranceScore = { score, label, bands, gaugeLower: num(endur?.gaugeLowerLimit), gaugeUpper: num(endur?.gaugeUpperLimit), history: hist };
  }

  // Lactate threshold: Garmin's speed figure is in units of 10 m/s (0.344 -> 3.44 m/s, about 7:48 per mile).
  {
    const latest = Array.isArray(ltLatest) ? ltLatest : [];
    const lhr = num(latest.find(r => num(r.hearRate) != null)?.hearRate);
    const lsp = num(latest.find(r => num(r.speed) != null)?.speed);
    const byDay = new Map<string, { t: number; hr: number | null; speedMs: number | null }>();
    const put = (rows: Json[] | null, k: "hr" | "speedMs") => (Array.isArray(rows) ? rows : []).forEach(r => {
      const day = String(r.from ?? ""), v = num(r.value), t = Date.parse(`${day}T12:00:00`);
      if (!Number.isFinite(t) || v == null) return;
      const e = byDay.get(day) ?? { t, hr: null, speedMs: null };
      e[k] = k === "speedMs" ? v * 10 : v;
      byDay.set(day, e);
    });
    put(ltHr, "hr"); put(ltSpeed, "speedMs");
    const history = Array.from(byDay.values()).sort((a, b) => a.t - b.t);
    const lastDay = String(latest[0]?.calendarDate ?? "").slice(0, 10) || null;
    if (lhr != null || lsp != null || history.length) {
      out.lactate = { hr: lhr ?? history[history.length - 1]?.hr ?? null, speedMs: lsp != null ? lsp * 10 : history[history.length - 1]?.speedMs ?? null, date: lastDay, history };
    }
  }

  cache.set(date, { at: Date.now(), value: out });
  return out;
}
