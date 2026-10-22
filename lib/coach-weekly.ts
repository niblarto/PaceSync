import { getDb } from "@/lib/db";
import { buildCoachContext, prefetchCoachData } from "@/lib/coach-context";
import { buildCoachSystemPrompt } from "@/lib/coach-prompt";
import { coachChat } from "@/lib/coach-llm";
import { coachModelLabel, loadCoachConfig } from "@/lib/coach-config";
import { commitSessionToMemory, recallPastAnalyses } from "@/lib/coach-memory";

// Weekly coach report ("coachWeekly" cron, Sunday 19:00 by default): the
// coach reviews the week just run against the plan, load and recovery, and
// sets up next week. Stored for the Coach page, notified, and saved into
// coaching memory so later conversations can refer back to it.

let ready = false;
function db() {
  const d = getDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS coach_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        week_start TEXT NOT NULL,
        created_at TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT
      );
    `);
    ready = true;
  }
  return d;
}

export interface CoachReport {
  id: number;
  weekStart: string; // Monday, YYYY-MM-DD
  createdAt: string;
  content: string;
  model: string | null;
}

interface Row { id: number; week_start: string; created_at: string; content: string; model: string | null }
const toReport = (r: Row): CoachReport => ({ id: r.id, weekStart: r.week_start, createdAt: r.created_at, content: r.content, model: r.model });

export function listReports(limit = 12): CoachReport[] {
  return (db().prepare("SELECT * FROM coach_reports ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(toReport);
}

export function latestReport(maxAgeDays = 8): CoachReport | null {
  const row = db().prepare("SELECT * FROM coach_reports ORDER BY created_at DESC LIMIT 1").get() as Row | undefined;
  if (!row) return null;
  return Date.now() - new Date(row.created_at).getTime() <= maxAgeDays * 86_400_000 ? toReport(row) : null;
}

export function deleteReport(id: number): void {
  db().prepare("DELETE FROM coach_reports WHERE id = ?").run(id);
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// The period being reviewed. Scheduled (Sunday): the Mon-Sun week, or last
// week if run early on a Monday before any training. Written by hand from
// the Coach page (rolling): the last 7 days up to and including today.
function reviewWeek(now = new Date(), rolling = false): { start: string; end: string; label: string } {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  if (rolling) {
    d.setDate(d.getDate() - 6);
  } else {
    const dow = (d.getDay() + 6) % 7; // 0 = Monday
    if (dow === 0 && now.getHours() < 12) d.setDate(d.getDate() - 7);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  }
  const end = new Date(d);
  end.setDate(end.getDate() + 6);
  const fmt = (x: Date) => x.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return { start: localDate(d), end: localDate(end), label: `${fmt(d)} – ${fmt(end)}` };
}

// The 7 days after the reviewed period: for a manual report that's
// tomorrow onwards; for the Sunday report, the coming Mon-Sun.
function nextPeriod(week: { end: string }): { start: string; end: string; label: string } {
  const s = new Date(`${week.end}T12:00:00`);
  s.setDate(s.getDate() + 1);
  const e = new Date(s);
  e.setDate(e.getDate() + 6);
  const fmt = (x: Date) => x.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return { start: localDate(s), end: localDate(e), label: `${fmt(s)} – ${fmt(e)}` };
}

function reportRequest(week: { start: string; end: string; label: string }, rolling = false): string {
  const period = rolling ? "these 7 days" : "this week";
  const n = nextPeriod(week);
  const next = `${rolling ? "**Next 7 days**" : "**Next week**"} — ${n.label} (${n.start} to ${n.end}) ONLY, one line per date in order, starting ${n.label.split(" – ")[0]}: the planned session for that date from PLANNED SESSIONS (or rest if none is listed)`;
  return `Write my ${rolling ? "coaching report for the last 7 days" : "weekly coaching report for the week"} ${week.label} (${week.start} to ${week.end}), using the TRAINING DATA.

Use exactly these sections, each as a bold heading line:
**Verdict** — 2-3 sentences: how ${period} went overall and the single most important takeaway.
**Plan vs actual** — each day of ${period} up to today (don't report on days that haven't happened yet). Take what was planned and what I did from the DAY BY DAY section exactly as written: never call a day a rest day unless it says "Rest day", and quote distances from it. For runs, use the SPLITS vs PLAN line: each split already has a verdict (✓ = hit, ⚠ = much faster than planned, ✗ = slower than target). Report those verdicts as given and never contradict them. Remember a lower pace number is faster: on target, slightly faster, or up to 5 s/mi slower is a hit. For easy/conversational runs, running at or slower than the cap is correct; never describe it as "slow" or a miss. Judge the session by its splits, not the overall average pace. For each day: what was planned, what I did (for interval/structured sessions use the workout laps: rep paces and heart rates against the target), and whether it hit the purpose of the session. Include walks, strength and other sessions from OTHER TRAINING on the days they happened, so a planned rest day with a walk or strength session isn't reported as "nothing logged". Mention my effort/feel ratings and notes where given.
**Load & recovery** — the mileage and training load (runs plus walks, strength and other sessions) for ${period} against the previous weeks, plus HRV, resting HR, sleep and body battery trends. Flag anything that needs attention.
${next} with specific guidance (target paces or heart rates, what to focus on, what to watch for), adjusted for how ${period} went.
**Race readiness** — only if a race is coming up: weeks to go and whether I'm on track.

Be specific and quote numbers. Under 500 words.`;
}

function verdictOf(content: string): string {
  const m = content.match(/\*\*Verdict\*\*[:\s—-]*([\s\S]*?)(?=\n\s*\*\*[A-Z][^*]+\*\*|\n#+\s|$)/);
  const text = (m?.[1] ?? content.split(/\n\s*\n/)[0] ?? content).replace(/\s+/g, " ").trim();
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}

export type WeeklyReportResult = { ok: true; report: CoachReport; verdict: string } | { ok: false; error: string };

// One report at a time; the Coach page polls this while it's being written.
const state = globalThis as unknown as { __coachReportWriting?: boolean; __coachReportError?: string | null };
export function reportWriteState(): { writing: boolean; error: string | null } {
  return { writing: !!state.__coachReportWriting, error: state.__coachReportError ?? null };
}

export async function generateWeeklyReport(opts: { rolling?: boolean } = {}): Promise<WeeklyReportResult> {
  if (state.__coachReportWriting) return { ok: false, error: "A report is already being written" };
  state.__coachReportWriting = true;
  state.__coachReportError = null;
  try {
    const result = await writeReport(!!opts.rolling);
    if (!result.ok) state.__coachReportError = result.error;
    return result;
  } finally {
    state.__coachReportWriting = false;
  }
}

async function writeReport(rolling: boolean): Promise<WeeklyReportResult> {
  const week = reviewWeek(new Date(), rolling);
  // Make sure this week's laps, weather and HRV are all in first.
  await prefetchCoachData().catch(() => {});
  const [context, recall] = await Promise.all([
    buildCoachContext(),
    recallPastAnalyses(`weekly training review ${week.label}: progress, recovery, injuries, plan changes`).catch(() => ({ memories: [], model: null })),
  ]);
  const system = buildCoachSystemPrompt(context.text, recall.memories.map(m => m.document));
  const reply = await coachChat(system, [{ role: "user", content: reportRequest(week, rolling) }]);
  if (!reply.ok) return { ok: false, error: reply.error };

  const model = coachModelLabel(loadCoachConfig());
  const createdAt = new Date().toISOString();
  const id = Number(db().prepare("INSERT INTO coach_reports (week_start, created_at, content, model) VALUES (?, ?, ?, ?)")
    .run(week.start, createdAt, reply.reply, model).lastInsertRowid);
  const report: CoachReport = { id, weekStart: week.start, createdAt, content: reply.reply, model };
  const verdict = verdictOf(reply.reply);

  // Into coaching memory, so later chats can refer back to this week.
  await commitSessionToMemory(`Weekly report for ${week.label}: ${verdict}`, ["weekly report"], null)
    .catch(err => console.warn("[coach] weekly report memory commit failed:", err));
  return { ok: true, report, verdict };
}

export function weekLabel(weekStart: string): string {
  const d = new Date(`${weekStart}T12:00:00`);
  const end = new Date(d);
  end.setDate(end.getDate() + 6);
  const fmt = (x: Date) => x.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return `${fmt(d)} – ${fmt(end)}`;
}
