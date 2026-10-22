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

// The Mon-Sun week being reviewed: this week, or last week if run early on
// a Monday before any training.
function reviewWeek(now = new Date()): { start: string; end: string; label: string } {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  if (dow === 0 && now.getHours() < 12) d.setDate(d.getDate() - 7);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const end = new Date(d);
  end.setDate(end.getDate() + 6);
  const fmt = (x: Date) => x.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return { start: localDate(d), end: localDate(end), label: `${fmt(d)} – ${fmt(end)}` };
}

function reportRequest(week: { start: string; end: string; label: string }): string {
  return `Write my weekly coaching report for the week ${week.label} (${week.start} to ${week.end}), using the TRAINING DATA.

Use exactly these sections, each as a bold heading line:
**Verdict** — 2-3 sentences: how the week went overall and the single most important takeaway.
**Plan vs actual** — each run this week: what was planned, what I did (for interval/structured sessions use the workout laps: rep paces and heart rates against the target), and whether it hit the purpose of the session. Mention my effort/feel ratings and notes where given.
**Load & recovery** — this week's mileage and training load against the previous weeks, plus HRV, resting HR, sleep and body battery trends. Flag anything that needs attention.
**Next week** — the planned sessions for the coming week with specific guidance (target paces or heart rates, what to focus on, what to watch for), adjusted for how this week went.
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

export async function generateWeeklyReport(): Promise<WeeklyReportResult> {
  if (state.__coachReportWriting) return { ok: false, error: "A report is already being written" };
  state.__coachReportWriting = true;
  state.__coachReportError = null;
  try {
    const result = await writeReport();
    if (!result.ok) state.__coachReportError = result.error;
    return result;
  } finally {
    state.__coachReportWriting = false;
  }
}

async function writeReport(): Promise<WeeklyReportResult> {
  const week = reviewWeek();
  // Make sure this week's laps, weather and HRV are all in first.
  await prefetchCoachData().catch(() => {});
  const [context, recall] = await Promise.all([
    buildCoachContext(),
    recallPastAnalyses(`weekly training review ${week.label}: progress, recovery, injuries, plan changes`).catch(() => ({ memories: [], model: null })),
  ]);
  const system = buildCoachSystemPrompt(context.text, recall.memories.map(m => m.document));
  const reply = await coachChat(system, [{ role: "user", content: reportRequest(week) }]);
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
