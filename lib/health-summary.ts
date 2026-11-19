import path from "path";
import { getDb } from "@/lib/db";
import { coachChat } from "@/lib/coach-llm";
import { formatCoachText } from "@/lib/coach-format";
import { coachModelLabel, loadCoachConfig } from "@/lib/coach-config";
import { loadGarminConfig } from "@/lib/garmin-config";
import { aiAvailable, cycleStart, nextCycleStart } from "@/lib/nutrition-summary";
import { buildHealthDashboard, type HealthDay } from "@/lib/health-dashboard";

// Daily AI summary of the last 30 days of sleep and HRV, for the /health page. Written the same way as the nutrition
// summary (lib/nutrition-summary.ts): one per cycle, a cycle starting at 05:00 local time; an hourly cron
// (/api/cron/health-summary) writes it once the AI answers, and the page asks every minute while one is due.

const SUMMARY_DAYS = 30;

let ready = false;
function db() {
  const d = getDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS health_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT
      );
    `);
    ready = true;
  }
  return d;
}

export interface HealthSummary { id: number; createdAt: string; periodStart: string; periodEnd: string; content: string; model: string | null }

interface Row { id: number; created_at: string; period_start: string; period_end: string; content: string; model: string | null }
const toSummary = (r: Row): HealthSummary => ({
  id: r.id, createdAt: r.created_at, periodStart: r.period_start, periodEnd: r.period_end, content: r.content, model: r.model,
});

export function latestHealthSummary(): HealthSummary | null {
  const row = db().prepare("SELECT * FROM health_summaries ORDER BY created_at DESC LIMIT 1").get() as Row | undefined;
  return row ? toSummary(row) : null;
}

export function isHealthSummaryDue(now = new Date()): boolean {
  const s = latestHealthSummary();
  return !s || new Date(s.createdAt) < cycleStart(now);
}

export { nextCycleStart };

const state = globalThis as unknown as { __healthSummaryWriting?: boolean; __healthSummaryError?: string | null };

export function healthSummaryWriteState(): { writing: boolean; error: string | null } {
  return { writing: !!state.__healthSummaryWriting, error: state.__healthSummaryError ?? null };
}

export type EnsureResult =
  | { status: "fresh" }
  | { status: "writing" }
  | { status: "unavailable"; reason: string };

// Starts writing the summary in the background if it's due and the AI is reachable. Returns immediately.
export async function ensureHealthSummary(opts: { force?: boolean } = {}): Promise<EnsureResult> {
  if (state.__healthSummaryWriting) return { status: "writing" };
  if (!opts.force && !isHealthSummaryDue()) return { status: "fresh" };
  const avail = await aiAvailable();
  if (!avail.ok) return { status: "unavailable", reason: avail.reason ?? "AI unavailable" };
  if (state.__healthSummaryWriting) return { status: "writing" };
  state.__healthSummaryWriting = true;
  state.__healthSummaryError = null;
  writeSummary()
    .then(r => { if (!r.ok) state.__healthSummaryError = r.error; })
    .catch(e => { state.__healthSummaryError = e instanceof Error ? e.message : String(e); })
    .finally(() => { state.__healthSummaryWriting = false; });
  return { status: "writing" };
}

// ── The data the AI is given ────────────────────────────────────────────────

const clock = (sec: number | null) => (sec == null ? "–" : `${Math.floor(sec / 3600)}h${String(Math.round((sec % 3600) / 60)).padStart(2, "0")}`);

// What was trained each day (sport and minutes), from GarminDB's activities.
function trainingByDay(since: string): Map<string, string> {
  const out = new Map<string, string[]>();
  const config = loadGarminConfig();
  if (!config) return new Map();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const g = new Database(path.join(config.dbPath, "garmin_activities.db"), { readonly: true, fileMustExist: true });
    g.pragma("busy_timeout = 30000");
    try {
      const rows = g.prepare("SELECT DATE(start_time) AS d, sport, elapsed_time AS e FROM activities WHERE DATE(start_time) >= ? ORDER BY start_time").all(since) as { d: string; sport: string | null; e: string | null }[];
      for (const r of rows) {
        const m = (r.e ?? "").match(/^(\d+):(\d+):(\d+)/);
        const mins = m ? Number(m[1]) * 60 + Number(m[2]) : null;
        out.set(r.d, [...(out.get(r.d) ?? []), `${(r.sport ?? "activity").replace(/_/g, " ")}${mins != null ? ` ${mins} min` : ""}`]);
      }
    } finally { g.close(); }
  } catch {}
  return new Map(Array.from(out.entries()).map(([d, v]) => [d, v.join(", ")]));
}

function dayLine(d: HealthDay, training: string | undefined): string {
  const parts = [d.date];
  // A night the user ignored (e.g. the watch came off in the night): its readings aren't real, so the AI isn't given them.
  if (d.ignored) return `${d.date} · sleep and HRV IGNORED by the user (readings unreliable, e.g. watch not worn all night) · training that day: ${training ?? "none"}`;
  if (d.sleepSec != null) {
    const stages = d.deepSec != null ? ` (deep ${clock(d.deepSec)}, REM ${clock(d.remSec)}, light ${clock(d.lightSec)}, awake ${clock(d.awakeSec)})` : "";
    parts.push(`sleep ${clock(d.sleepSec)}${d.sleepScore != null ? `, score ${d.sleepScore}${d.sleepQualifier ? ` ${d.sleepQualifier.toLowerCase()}` : ""}` : ""}${stages}`);
  } else parts.push("sleep: no data");
  if (d.hrv != null) {
    const extra = [d.hrvWeekly != null && `7-day avg ${d.hrvWeekly}`, d.hrvLow != null && d.hrvHigh != null && `baseline ${d.hrvLow}–${d.hrvHigh}`, d.hrvStatus?.toLowerCase()]
      .filter(Boolean).join(", ");
    parts.push(`HRV ${d.hrv} ms${extra ? ` (${extra})` : ""}`);
  } else parts.push("HRV: no data");
  if (d.restingHr != null) parts.push(`resting HR ${d.restingHr}`);
  parts.push(`training that day: ${training ?? "none"}`);
  return parts.join(" · ");
}

async function dataText(): Promise<{ text: string; start: string; end: string }> {
  const dash = await buildHealthDashboard(SUMMARY_DAYS);
  // The last 30 days up to today (this morning's sleep and HRV belong to today).
  const days = dash.days;
  const training = trainingByDay(days[0]?.date ?? dash.today);
  const a = dash.avgAll, a7 = dash.avg7;
  const summary = [
    `Nights with sleep recorded: ${a.nights} of ${days.length}`,
    `Average sleep: ${clock(a.sleepSec)} over the period (${clock(a7.sleepSec)} over the last 7 days)`,
    `Average sleep score: ${a.sleepScore ?? "–"} (last 7 days ${a7.sleepScore ?? "–"})`,
    `Average HRV: ${a.hrv ?? "–"} ms (last 7 days ${a7.hrv ?? "–"} ms)`,
    `Average resting HR: ${a.restingHr ?? "–"} bpm (last 7 days ${a7.restingHr ?? "–"})`,
  ];
  // Garmin's own Sleep Coach recommendation, so the AI can build on it rather than guess at sleep need.
  const sc = dash.sleepCoach, tn = sc?.tonight;
  const coach = sc
    ? [
        tn ? `Tonight Garmin recommends ${clock(tn.needMin * 60)} of sleep (your baseline need is ${clock(tn.baselineMin * 60)}${tn.change ? `; ${tn.change.toLowerCase()}` : ""}${tn.reasons.length ? ` because of ${tn.reasons.join(" and ")}` : ""})` : null,
        sc.verdict ? `Garmin's verdict on last night's sleep: ${sc.verdict.toLowerCase()}${sc.insight ? `; ${sc.insight.toLowerCase()}` : ""}` : null,
      ].filter(Boolean)
    : [];
  const text = `SUMMARY FIGURES\n${summary.join("\n")}${coach.length ? `\n\nGARMIN SLEEP COACH\n${coach.join("\n")}` : ""}\n\nDAILY DATA (sleep is filed under the morning you woke; HRV is the overnight average)\n${days.map(d => dayLine(d, training.get(d.date))).join("\n")}`;
  return { text, start: days[0]?.date ?? dash.today, end: days[days.length - 1]?.date ?? dash.today };
}

const SYSTEM = `You are a sports-science coach reviewing a runner's sleep and heart rate variability (HRV) from their Garmin watch.
You get the last 30 days: each night's sleep (total, stages, score), the overnight HRV with Garmin's 7-day average and its "balanced" baseline band, resting heart rate, and what training was done each day.
Be specific, quote numbers and dates, and be honest but encouraging. Use British English. Don't invent figures that aren't in the data, and don't give medical diagnoses.
Days marked "no data" simply weren't recorded: mention gaps rather than treating them as zero.
Nights marked "IGNORED" have unreliable readings (for example the watch was taken off): leave them out of every figure and comparison, and don't call them poor nights.`;

const REQUEST = `Write today's summary of the last 30 days of sleep and HRV. Use exactly these sections, each as a bold heading line:
**Overview** — 2-3 sentences: how the month went and the single most important takeaway.
**Sleep** — average duration and score, best and worst nights, consistency, how much deep and REM sleep, and the trend over the month.
**HRV & recovery** — HRV against the baseline band, the direction of the 7-day average, resting heart rate, and any run of unbalanced or low days.
**Sleep, HRV and training** — whether hard sessions or long runs were followed by lower HRV or poorer sleep, and how quickly it recovered.
**Next few days** — 2-3 concrete actions.
Under 350 words.

Formatting: put each bold heading on its own line with nothing after it. Under it, write one bullet ("- ") per day or item, each on its own line, e.g.
**Sleep**
- Averaged 6h42 a night, score 71
- Best night: Tue 20 (7h30, score 88)
Never join several days or items on one line with "|" or ";". Verdict and other short summaries can be 1-3 plain sentences.`;

async function writeSummary(): Promise<{ ok: true; summary: HealthSummary } | { ok: false; error: string }> {
  const { text, start, end } = await dataText();
  const reply = await coachChat(`${SYSTEM}\n\n### DATA\n${text}`, [{ role: "user", content: REQUEST }], { think: true });
  if (!reply.ok) return { ok: false, error: reply.error };
  reply.reply = formatCoachText(reply.reply, { splitHeadings: true });
  const model = reply.model || coachModelLabel(loadCoachConfig());
  const createdAt = new Date().toISOString();
  const id = Number(db().prepare(
    "INSERT INTO health_summaries (created_at, period_start, period_end, content, model) VALUES (?, ?, ?, ?, ?)",
  ).run(createdAt, start, end, reply.reply, model).lastInsertRowid);
  return { ok: true, summary: { id, createdAt, periodStart: start, periodEnd: end, content: reply.reply, model } };
}
