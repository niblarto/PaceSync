import { coachChat } from "@/lib/coach-llm";
import { commitSessionToMemory } from "@/lib/coach-memory";
import { endSession, openSessionLastActivity, setSessionSummary, type StoredCoachMessage } from "@/lib/coach-store";

// Closing a conversation: the coach writes its own session summary +
// keywords (the repo had the athlete type them in by hand), which go into
// coaching memory via commitSessionToMemory.

const IDLE_CLOSE_MS = 3 * 60 * 60_000;

const SUMMARY_SYSTEM = `You maintain a running coach's notes about one athlete.
Summarise the coaching conversation you are given so the coach can pick up where it left off in a future session.
Include: what the athlete asked or reported (symptoms, feelings, life constraints), the coach's key conclusions and any advice or plan changes agreed, and anything to follow up on. Keep concrete numbers (paces, distances, dates, heart rates). 2-5 sentences, third person ("The athlete…"). Do not invent anything that wasn't said.
Reply with ONLY a JSON object: {"summary": "...", "keywords": ["3-6 short topic keywords"]}`;

// In-flight summaries, so a close that races another close doesn't
// summarise the same session twice.
const summarising = new Set<number>();

function parseSummary(text: string): { summary: string; keywords: string[] } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const d = JSON.parse(m[0]) as { summary?: unknown; keywords?: unknown };
    const summary = typeof d.summary === "string" ? d.summary.trim() : "";
    if (!summary) return null;
    const keywords = Array.isArray(d.keywords) ? d.keywords.map(k => String(k).trim().toLowerCase()).filter(Boolean).slice(0, 8) : [];
    return { summary, keywords };
  } catch {
    return null;
  }
}

async function summariseAndCommit(sessionId: number, messages: StoredCoachMessage[]): Promise<void> {
  // Nothing worth remembering without at least one coach reply.
  if (!messages.some(m => m.role === "assistant") || summarising.has(sessionId)) return;
  summarising.add(sessionId);
  try {
    const transcript = messages.map(m => `${m.role === "user" ? "Athlete" : "Coach"}: ${m.content}`).join("\n\n");
    const reply = await coachChat(SUMMARY_SYSTEM, [{ role: "user", content: `Conversation (${messages[0].createdAt.slice(0, 10)}):\n\n${transcript}` }]);
    if (!reply.ok) {
      console.warn(`[coach] session ${sessionId} summary failed: ${reply.error}`);
      return;
    }
    const parsed = parseSummary(reply.reply);
    if (!parsed) {
      console.warn(`[coach] session ${sessionId} summary wasn't valid JSON`);
      return;
    }
    setSessionSummary(sessionId, parsed.summary, parsed.keywords);
    await commitSessionToMemory(parsed.summary, parsed.keywords, sessionId);
  } catch (err) {
    console.warn(`[coach] session ${sessionId} memory commit failed:`, err);
  } finally {
    summarising.delete(sessionId);
  }
}

// Ends the session and summarises it in the background (the caller doesn't
// wait — the summary takes as long as a coach reply).
export function closeSession(sessionId: number): void {
  const messages = endSession(sessionId);
  if (messages.length) void summariseAndCommit(sessionId, messages);
}

// Closes the open conversation if it's been quiet for 3 hours, so the next
// message starts a fresh session that can recall this one.
export function closeIdleSession(): boolean {
  const open = openSessionLastActivity();
  if (!open || Date.now() - new Date(open.at).getTime() < IDLE_CLOSE_MS) return false;
  closeSession(open.id);
  return true;
}

export function isSummarising(): boolean {
  return summarising.size > 0;
}
