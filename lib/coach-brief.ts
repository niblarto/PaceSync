import { createHash } from "crypto";
import { getDb } from "@/lib/db";
import { buildCoachSystemPrompt } from "@/lib/coach-prompt";
import { coachChat } from "@/lib/coach-llm";
import { coachModelLabel, loadCoachConfig } from "@/lib/coach-config";
import { aiAvailable } from "@/lib/nutrition-summary";
import { fetchRunnaSchedule, type RunnaWorkout } from "@/lib/runna-schedule";

// The "next two weeks" panel at the top of the Runna Schedule card. The
// mileage and key sessions are worked out here from the Runna plan (a model
// can't be trusted to add up or quote a plan from a long context); the AI adds
// one qualitative sentence on the shape of the fortnight, and it is thrown
// away if it mentions any number, day or date. The sentence is rewritten when
// the plan or the day changes or after an activity update (markBriefStale, from
// the post-sync hook), as soon as the AI is available: right away if it is,
// otherwise on the next check. A change to the Runna plan is noticed whenever
// the schedule is served (the dashboard polls it every few minutes) and by a
// cron every 15 minutes for when the dashboard is closed. The Refresh button
// forces a new one.

const KEY = "coach_brief_ahead";
const STALE_KEY = "coach_brief_stale";
const DAYS_AHEAD = 14;

export interface ScheduleBrief {
  /** The AI's sentence ("" if it wrote nothing usable). */
  summary: string;
  createdAt: string; // ISO
  model: string | null;
  /** Which schedule it was written for. */
  factsHash: string;
  /** What the AI wrote when it was thrown away for quoting a number, day or date (kept to see why). */
  rejected?: string;
}

export interface ScheduleFacts {
  /** The lines shown in the panel (markdown bold lead-ins). */
  lines: string[];
  /** The same plan as plain text for the AI's prompt. */
  text: string;
  hash: string;
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayLabel(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function describe(w: RunnaWorkout): string {
  return `${w.title}${w.distanceMi ? ` (${w.distanceMi.toFixed(1)}mi)` : ""}`;
}

// The next 14 days of the Runna plan (today included), added up in code.
export async function scheduleFacts(now = new Date()): Promise<ScheduleFacts | null> {
  const schedule = await fetchRunnaSchedule().catch(() => null);
  if (!schedule?.ok) return null;
  const today = localDate(now);
  const weekEnd = localDate(new Date(now.getTime() + 6 * 86_400_000));
  const end = localDate(new Date(now.getTime() + (DAYS_AHEAD - 1) * 86_400_000));
  const items = schedule.workouts.filter(w => w.date >= today && w.date <= end).sort((a, b) => a.date.localeCompare(b.date));
  if (!items.length) return null;

  const runs = items.filter(w => w.type !== "rest" && w.type !== "strength" && w.distanceMi);
  const miles = (xs: RunnaWorkout[]) => xs.reduce((sum, w) => sum + (w.distanceMi ?? 0), 0);
  const first = runs.filter(w => w.date <= weekEnd);
  const second = runs.filter(w => w.date > weekEnd);
  const key = runs.filter(w => w.type === "long_run" || w.type === "tempo" || w.type === "interval" || w.type === "race");
  const rest = items.filter(w => w.type === "rest").length;
  const strength = items.filter(w => w.type === "strength").length;

  const lines: string[] = [];
  if (runs.length) {
    lines.push(`**Mileage:** ${miles(runs).toFixed(1)}mi planned over ${runs.length} run${runs.length === 1 ? "" : "s"}: ${miles(first).toFixed(1)}mi in the next 7 days (${first.length}), ${miles(second).toFixed(1)}mi in the 7 after (${second.length}).`);
  }
  if (key.length) {
    lines.push(`**Key sessions:** ${key.slice(0, 8).map(w => `${dayLabel(w.date)} ${describe(w)}`).join("; ")}.`);
  }
  const also = [rest ? `${rest} rest day${rest === 1 ? "" : "s"}` : "", strength ? `${strength} strength session${strength === 1 ? "" : "s"}` : ""].filter(Boolean);
  if (also.length) lines.push(`**Also:** ${also.join(", ")}.`);

  const text = [
    `## PLANNED SCHEDULE — next ${DAYS_AHEAD} days (${today} to ${end}), from the Runna plan; the totals are exact`,
    ...items.map(w => `- ${dayLabel(w.date)}: ${w.type === "rest" ? "Rest" : describe(w)}`),
    `- Totals: ${miles(runs).toFixed(1)}mi over ${runs.length} runs (${miles(first).toFixed(1)}mi in the first 7 days, ${miles(second).toFixed(1)}mi in the 7 after), ${rest} rest days, ${strength} strength sessions`,
  ].join("\n");
  return { lines, text, hash: createHash("sha1").update(text).digest("hex").slice(0, 12) };
}

export function loadBrief(): ScheduleBrief | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as ScheduleBrief : null;
  } catch {
    return null;
  }
}

function putKv(key: string, value: unknown): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(key, JSON.stringify(value));
}

// An activity update arrived: the saved sentence may no longer fit.
export function markBriefStale(): void {
  putKv(STALE_KEY, new Date().toISOString());
}

function markedStaleAfter(createdAt: string): boolean {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(STALE_KEY) as { value_json: string } | undefined;
    const marked = row ? JSON.parse(row.value_json) as string : null;
    return !!marked && marked > createdAt;
  } catch {
    return false;
  }
}

// What the panel shows, and whether the AI sentence needs rewriting: it does if
// there isn't one for this schedule (the plan or the day changed) or an activity
// update has come in since.
export async function briefStatus(): Promise<{ facts: ScheduleFacts | null; brief: ScheduleBrief | null; stale: boolean }> {
  const facts = await scheduleFacts();
  const brief = loadBrief();
  const stale = !!facts && (!brief || brief.factsHash !== facts.hash || markedStaleAfter(brief.createdAt));
  return { facts, brief, stale };
}

// One at a time; the dashboard polls this while it's being written.
const state = globalThis as unknown as {
  __coachBriefWriting?: boolean;
  __coachBriefError?: string | null;
  /** Why a wanted refresh couldn't start (the AI wasn't reachable), until one does. */
  __coachBriefWaiting?: string | null;
  /** When a background check last found the AI unreachable. */
  __coachBriefLastTry?: number;
};
export function briefWriteState(): { writing: boolean; error: string | null; waiting: string | null } {
  return { writing: !!state.__coachBriefWriting, error: state.__coachBriefError ?? null, waiting: state.__coachBriefWaiting ?? null };
}

export type EnsureBriefResult =
  | { status: "fresh" } // nothing new since the last one
  | { status: "writing" } // started now, or already in progress
  | { status: "unavailable"; reason: string };

// Starts writing a new sentence in the background if one is wanted (stale, or
// `force`) and the AI is reachable; returns straight away. If the AI isn't
// reachable it stays stale, so the next check (hourly cron, a new activity
// update, or the open dashboard) tries again.
export async function ensureBrief(opts: { force?: boolean } = {}): Promise<EnsureBriefResult> {
  if (state.__coachBriefWriting) return { status: "writing" };
  if (!opts.force && !(await briefStatus()).stale) {
    state.__coachBriefWaiting = null;
    return { status: "fresh" };
  }
  // Checks come often (every schedule poll), so don't ping an unreachable AI
  // service more than once a minute.
  if (!opts.force && state.__coachBriefWaiting && Date.now() - (state.__coachBriefLastTry ?? 0) < 60_000) {
    return { status: "unavailable", reason: state.__coachBriefWaiting };
  }
  const avail = await aiAvailable();
  if (!avail.ok) {
    state.__coachBriefWaiting = avail.reason ?? "The AI isn't available";
    state.__coachBriefLastTry = Date.now();
    return { status: "unavailable", reason: state.__coachBriefWaiting };
  }
  if (state.__coachBriefWriting) return { status: "writing" };
  state.__coachBriefWaiting = null;
  void generateBrief();
  return { status: "writing" };
}

const REQUEST = `Write ONE sentence of at most 30 words on the shape of my next two weeks of planned training, using only the PLANNED SCHEDULE: whether the load builds, holds or eases, and how the hard sessions are spread. Do not mention any number, distance, date, weekday or month — the app prints those itself — and do not mention a session that isn't in the schedule. No heading, no bullet, no preamble.`;

// Anything with a digit, weekday or month is dropped: the app prints the facts.
const HAS_FACT = /\d|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i;

function usableSentence(reply: string): string {
  const s = reply.replace(/\*\*/g, "").replace(/^\s*[-•*]\s+/gm, "").replace(/\s+/g, " ").trim();
  return s && !HAS_FACT.test(s) ? s : "";
}

export async function generateBrief(): Promise<{ ok: true; brief: ScheduleBrief } | { ok: false; error: string }> {
  if (state.__coachBriefWriting) return { ok: false, error: "A summary is already being written" };
  state.__coachBriefWriting = true;
  state.__coachBriefError = null;
  try {
    const facts = await scheduleFacts();
    if (!facts) {
      state.__coachBriefError = "No planned sessions in the next two weeks";
      return { ok: false, error: state.__coachBriefError };
    }
    const reply = await coachChat(buildCoachSystemPrompt(facts.text, []), [{ role: "user", content: REQUEST }], { think: false });
    if (!reply.ok) {
      state.__coachBriefError = reply.error;
      return { ok: false, error: reply.error };
    }
    const summary = usableSentence(reply.reply);
    const brief: ScheduleBrief = {
      summary,
      rejected: summary ? undefined : reply.reply.slice(0, 400),
      createdAt: new Date().toISOString(),
      model: reply.model || coachModelLabel(loadCoachConfig()),
      factsHash: facts.hash,
    };
    putKv(KEY, brief);
    return { ok: true, brief };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    state.__coachBriefError = error;
    return { ok: false, error };
  } finally {
    state.__coachBriefWriting = false;
  }
}
