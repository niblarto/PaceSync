import { getDb } from "@/lib/db";
import { loadAiDjConfig } from "@/lib/ai-dj-config";
import { coachChat } from "@/lib/coach-llm";
import { coachModelLabel, loadCoachConfig } from "@/lib/coach-config";
import { buildNutritionDashboard } from "@/lib/nutrition-dashboard";
import { formatWeight, formatWeightDelta } from "@/lib/weight-format";

// Daily AI summary of the last 14 days of nutrition, for the /nutrition page.
//
// One summary per "cycle": a cycle starts at 05:00 local time. A summary is
// due when none has been written since the current cycle started. It isn't
// written at exactly 05:00 because the AI DJ service PC (which runs the
// local model) may be off; instead:
//   - an hourly cron (/api/cron/nutrition-summary) writes it once the
//     service answers, and
//   - the page, when it finds no summary, asks every minute until it can.

const CYCLE_HOUR = 5;
const SUMMARY_DAYS = 14;

let ready = false;
function db() {
  const d = getDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS nutrition_summaries (
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

export interface NutritionSummary {
  id: number;
  createdAt: string;
  periodStart: string;
  periodEnd: string;
  content: string;
  model: string | null;
}

interface Row { id: number; created_at: string; period_start: string; period_end: string; content: string; model: string | null }
const toSummary = (r: Row): NutritionSummary => ({
  id: r.id, createdAt: r.created_at, periodStart: r.period_start, periodEnd: r.period_end, content: r.content, model: r.model,
});

export function latestSummary(): NutritionSummary | null {
  const row = db().prepare("SELECT * FROM nutrition_summaries ORDER BY created_at DESC LIMIT 1").get() as Row | undefined;
  return row ? toSummary(row) : null;
}

// Start of the current cycle: today 05:00, or yesterday 05:00 if it's
// earlier than 05:00 now.
export function cycleStart(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(CYCLE_HOUR, 0, 0, 0);
  if (now < d) d.setDate(d.getDate() - 1);
  return d;
}

export function nextCycleStart(now = new Date()): Date {
  const d = cycleStart(now);
  d.setDate(d.getDate() + 1);
  return d;
}

export function isSummaryDue(now = new Date()): boolean {
  const s = latestSummary();
  return !s || new Date(s.createdAt) < cycleStart(now);
}

// Can the summary be written right now? The local model needs the AI DJ
// service PC to be on; Claude/Gemini run on the Pi itself.
export async function aiAvailable(): Promise<{ ok: boolean; reason?: string }> {
  const coach = loadCoachConfig();
  if (coach.provider !== "local") return { ok: true };
  const dj = loadAiDjConfig();
  if (!dj?.url) return { ok: false, reason: "AI DJ service URL isn't set" };
  try {
    const res = await fetch(`${dj.url.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, reason: `AI DJ service returned ${res.status}` };
    const data = await res.json() as { ok?: boolean; llm?: boolean };
    if (!data.ok) return { ok: false, reason: "AI DJ service isn't ready" };
    if (data.llm === false) return { ok: false, reason: "AI DJ service's local model isn't loaded" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "AI DJ service is unreachable" };
  }
}

// ── Writing ─────────────────────────────────────────────────────────────────

const state = globalThis as unknown as { __nutritionSummaryWriting?: boolean; __nutritionSummaryError?: string | null };

export function summaryWriteState(): { writing: boolean; error: string | null } {
  return { writing: !!state.__nutritionSummaryWriting, error: state.__nutritionSummaryError ?? null };
}

export type EnsureResult =
  | { status: "fresh" } // already written this cycle
  | { status: "writing" } // started now, or already in progress
  | { status: "unavailable"; reason: string };

// Starts writing the summary in the background if it's due and the AI is
// reachable. Returns immediately; poll summaryWriteState()/latestSummary().
export async function ensureSummary(opts: { force?: boolean } = {}): Promise<EnsureResult> {
  if (state.__nutritionSummaryWriting) return { status: "writing" };
  if (!opts.force && !isSummaryDue()) return { status: "fresh" };
  const avail = await aiAvailable();
  if (!avail.ok) return { status: "unavailable", reason: avail.reason ?? "AI unavailable" };
  if (state.__nutritionSummaryWriting) return { status: "writing" };
  state.__nutritionSummaryWriting = true;
  state.__nutritionSummaryError = null;
  writeSummary()
    .then(r => { if (!r.ok) state.__nutritionSummaryError = r.error; })
    .catch(e => { state.__nutritionSummaryError = e instanceof Error ? e.message : String(e); })
    .finally(() => { state.__nutritionSummaryWriting = false; });
  return { status: "writing" };
}

function dataText(): { text: string; start: string; end: string } {
  const dash = buildNutritionDashboard(SUMMARY_DAYS + 1);
  const unit = dash.config.weightUnit;
  // The 14 complete days before today.
  const days = dash.days.filter(d => d.date < dash.today).slice(-SUMMARY_DAYS);
  const lines = days.map(d => {
    const parts = [d.date];
    parts.push(d.eaten != null ? `eaten ${d.eaten} kcal` : "eaten: not logged");
    if (d.proteinG != null) parts.push(`P ${Math.round(d.proteinG)}g C ${Math.round(d.carbsG ?? 0)}g F ${Math.round(d.fatG ?? 0)}g`);
    if (d.burnt != null) parts.push(`burnt ${d.burnt} kcal (resting ${d.resting ?? "?"})`);
    if (d.exercise != null) parts.push(`exercise ${d.exercise} kcal`);
    if (d.net != null) parts.push(`net ${d.net > 0 ? "+" : ""}${d.net} (eaten − burnt; ${d.net <= 0 ? "deficit" : "gain"})`);
    if (d.weightKg != null) parts.push(`weight ${formatWeight(d.weightKg, unit)}`);
    return parts.join(" · ");
  });
  const c = dash.config;
  const goals = [
    `Current weight: ${dash.current ? `${formatWeight(dash.current.kg, unit)} (7-day avg ${formatWeight(dash.current.avg7Kg, unit)})` : "unknown"}`,
    `Target weight: ${formatWeight(c.targetWeightKg, unit)}`,
    `Goal date: ${c.goalDate ?? "not set"}`,
    `Daily calorie limit (eaten): ${c.dailyCalorieLimit ?? "not set"} kcal`,
  ];
  if (dash.required) {
    goals.push(`Needed to hit goal on time: ${formatWeightDelta(dash.required.kgPerWeek, unit)}/week, daily balance ${dash.required.dailyBalance} kcal`);
  }
  const proj = dash.projections.map(p =>
    `${p.label} (${p.basis}): ${formatWeightDelta(p.kgPerWeek, unit)}/week; weight on goal date ${formatWeight(p.weightAtGoalKg, unit)}; target reached ${p.hitStatus === "on-course" ? p.hitDate : p.hitStatus === "reached" ? "already" : "not at this rate"}`,
  );
  const text = `GOALS\n${goals.join("\n")}\n\nPROJECTIONS\n${proj.join("\n") || "none yet"}\n\nDAILY DATA (food from Lose It!, burn and weight from Garmin; net = eaten − burnt, negative = deficit)\n${lines.join("\n")}`;
  return { text, start: days[0]?.date ?? dash.today, end: days[days.length - 1]?.date ?? dash.today };
}

const SYSTEM = `You are a sports nutritionist working with a runner who wants to lose weight while training well.
You get their last 14 days of food logging (Lose It!), calories burnt and weight (Garmin), their goals and projections.
Be specific, quote numbers, and be honest but encouraging. Use British English. Weights in the units given.
Days marked "not logged" have no food data: don't treat them as zero calories, mention logging gaps instead.`;

const REQUEST = `Write today's nutrition summary of the last 14 days. Use exactly these sections, each as a bold heading line:
**Overview** — 2-3 sentences: how the fortnight went and the single most important takeaway.
**Calories** — average eaten vs the daily limit, days over the limit, average net (eaten − burnt), average burnt, average deficit, best and worst days, and logging gaps.
**Macros** — protein per kg of body weight, carbs on training vs rest days, anything out of balance (skip if no macro data).
**Weight & goal** — the weight trend against the goal and whether the current deficit gets there by the goal date.
**Next few days** — 2-3 concrete actions.
Under 350 words.`;

async function writeSummary(): Promise<{ ok: true; summary: NutritionSummary } | { ok: false; error: string }> {
  const { text, start, end } = dataText();
  const reply = await coachChat(`${SYSTEM}\n\n### DATA\n${text}`, [{ role: "user", content: REQUEST }], { think: true });
  if (!reply.ok) return { ok: false, error: reply.error };
  const model = coachModelLabel(loadCoachConfig());
  const createdAt = new Date().toISOString();
  const id = Number(db().prepare(
    "INSERT INTO nutrition_summaries (created_at, period_start, period_end, content, model) VALUES (?, ?, ?, ?, ?)",
  ).run(createdAt, start, end, reply.reply, model).lastInsertRowid);
  return { ok: true, summary: { id, createdAt, periodStart: start, periodEnd: end, content: reply.reply, model } };
}
