import { getDb } from "@/lib/db";
import type { CoachMessage } from "@/lib/coach-llm";

// Coach conversations. One open session at a time; "New conversation" on
// the Coach page (or 3 hours without a message) closes it, and
// lib/coach-session.ts summarises it into coaching memory.

let ready = false;
function db() {
  const d = getDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS coach_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        summary TEXT,
        keywords TEXT
      );
      CREATE TABLE IF NOT EXISTS coach_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        model TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_coach_messages_session ON coach_messages(session_id, id);
    `);
    const cols = d.prepare("PRAGMA table_info(coach_messages)").all() as { name: string }[];
    if (!cols.some(c => c.name === "recalled")) d.exec("ALTER TABLE coach_messages ADD COLUMN recalled TEXT");
    ready = true;
  }
  return d;
}

export interface StoredCoachMessage extends CoachMessage {
  id: number;
  createdAt: string;
  model: string | null;
  // Memory ids the coach recalled for this reply (assistant messages only).
  recalled: string[];
}

export function getOpenSessionId(create = false): number | null {
  const row = db().prepare("SELECT id FROM coach_sessions WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
  if (row) return row.id;
  if (!create) return null;
  return Number(db().prepare("INSERT INTO coach_sessions (started_at) VALUES (?)").run(new Date().toISOString()).lastInsertRowid);
}

export function getSessionMessages(sessionId: number): StoredCoachMessage[] {
  const rows = db().prepare("SELECT id, role, content, created_at, model, recalled FROM coach_messages WHERE session_id = ? ORDER BY id").all(sessionId) as
    { id: number; role: string; content: string; created_at: string; model: string | null; recalled: string | null }[];
  return rows.map(r => ({
    id: r.id, role: r.role === "assistant" ? "assistant" : "user", content: r.content, createdAt: r.created_at, model: r.model,
    recalled: r.recalled ? r.recalled.split(",").filter(Boolean) : [],
  }));
}

export function addMessage(sessionId: number, role: CoachMessage["role"], content: string, model?: string, recalled: string[] = []): StoredCoachMessage {
  const createdAt = new Date().toISOString();
  const id = Number(db().prepare("INSERT INTO coach_messages (session_id, role, content, created_at, model, recalled) VALUES (?, ?, ?, ?, ?, ?)")
    .run(sessionId, role, content, createdAt, model ?? null, recalled.join(",") || null).lastInsertRowid);
  return { id, role, content, createdAt, model: model ?? null, recalled };
}

// When the open session's last message was sent (null = no open session or
// it's empty).
export function openSessionLastActivity(): { id: number; at: string } | null {
  const row = db().prepare(`
    SELECT s.id, MAX(m.created_at) AS at FROM coach_sessions s JOIN coach_messages m ON m.session_id = s.id
    WHERE s.ended_at IS NULL GROUP BY s.id ORDER BY s.id DESC LIMIT 1
  `).get() as { id: number; at: string } | undefined;
  return row ?? null;
}

export function setSessionSummary(sessionId: number, summary: string, keywords: string[]): void {
  db().prepare("UPDATE coach_sessions SET summary = ?, keywords = ? WHERE id = ?").run(summary, keywords.join(", "), sessionId);
}

export function deleteMessage(id: number): void {
  db().prepare("DELETE FROM coach_messages WHERE id = ?").run(id);
}

// Closes a session. Returns its messages (empty sessions are just deleted).
export function endSession(sessionId: number): StoredCoachMessage[] {
  const messages = getSessionMessages(sessionId);
  if (messages.length === 0) {
    db().prepare("DELETE FROM coach_sessions WHERE id = ?").run(sessionId);
    return [];
  }
  db().prepare("UPDATE coach_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL").run(new Date().toISOString(), sessionId);
  return messages;
}
