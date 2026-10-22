import { getDb } from "@/lib/db";

// Post-run effort (1-10, RPE) and feel (1-5) + notes, entered on the
// Dashboard's Summary cards (fields from ai-running-coach's main_log:
// effort_level, feel_score, notes). Keyed by run date + title, like the
// rest of the Summary card's per-run data. Read by the Coach.

let ready = false;
function db() {
  const d = getDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS run_feedback (
        date TEXT NOT NULL,
        title TEXT NOT NULL,
        effort INTEGER,
        feel INTEGER,
        notes TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (date, title)
      );
    `);
    ready = true;
  }
  return d;
}

export interface RunFeedback {
  date: string;
  title: string;
  effort: number | null; // 1-10
  feel: number | null;   // 1-5
  notes: string | null;
  updatedAt: string;
}

interface Row { date: string; title: string; effort: number | null; feel: number | null; notes: string | null; updated_at: string }
const toFeedback = (r: Row): RunFeedback => ({ date: r.date, title: r.title, effort: r.effort, feel: r.feel, notes: r.notes, updatedAt: r.updated_at });

export const FEEL_LABELS = ["Very weak", "Weak", "Normal", "Strong", "Very strong"] as const;

export function effortLabel(effort: number): string {
  if (effort <= 2) return "very easy";
  if (effort <= 4) return "easy";
  if (effort <= 6) return "moderate";
  if (effort <= 8) return "hard";
  if (effort === 9) return "very hard";
  return "maximal";
}

export function listRunFeedback(fromDate: string, toDate = "9999-12-31"): RunFeedback[] {
  return (db().prepare("SELECT * FROM run_feedback WHERE date >= ? AND date <= ? ORDER BY date DESC").all(fromDate, toDate) as Row[]).map(toFeedback);
}

export function getRunFeedback(date: string, title: string): RunFeedback | null {
  const row = db().prepare("SELECT * FROM run_feedback WHERE date = ? AND title = ?").get(date, title) as Row | undefined;
  return row ? toFeedback(row) : null;
}

export function saveRunFeedback(date: string, title: string, effort: number | null, feel: number | null, notes: string | null): RunFeedback | null {
  const clean = (n: number | null, max: number) => (n == null || !Number.isFinite(n) ? null : Math.min(max, Math.max(1, Math.round(n))));
  const e = clean(effort, 10);
  const f = clean(feel, 5);
  const n = notes?.trim() ? notes.trim().slice(0, 2000) : null;
  if (e == null && f == null && n == null) {
    db().prepare("DELETE FROM run_feedback WHERE date = ? AND title = ?").run(date, title);
    return null;
  }
  const updatedAt = new Date().toISOString();
  db().prepare(`
    INSERT INTO run_feedback (date, title, effort, feel, notes, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, title) DO UPDATE SET effort = excluded.effort, feel = excluded.feel, notes = excluded.notes, updated_at = excluded.updated_at
  `).run(date, title, e, f, n, updatedAt);
  return { date, title, effort: e, feel: f, notes: n, updatedAt };
}
