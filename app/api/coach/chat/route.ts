import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { buildCoachContext } from "@/lib/coach-context";
import { buildCoachSystemPrompt } from "@/lib/coach-prompt";
import { coachChat } from "@/lib/coach-llm";
import { coachModelLabel, loadCoachConfig } from "@/lib/coach-config";
import { recallPastAnalyses } from "@/lib/coach-memory";
import { closeIdleSession } from "@/lib/coach-session";
import { latestReport, weekLabel } from "@/lib/coach-weekly";
import { addMessage, deleteMessage, getOpenSessionId, getSessionMessages } from "@/lib/coach-store";

export const dynamic = "force-dynamic";
export const maxDuration = 330;

// Longest conversation sent to the model — older turns drop off the front.
const MAX_TURNS = 30;

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  closeIdleSession();
  const id = getOpenSessionId();
  return NextResponse.json({
    messages: id == null ? [] : getSessionMessages(id),
    model: coachModelLabel(loadCoachConfig()),
  });
}

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { message } = await req.json() as { message?: string };
  const text = (message ?? "").trim();
  if (!text) return NextResponse.json({ error: "Empty message" }, { status: 400 });

  closeIdleSession();
  const sessionId = getOpenSessionId(true)!;
  const userMsg = addMessage(sessionId, "user", text);
  const history = getSessionMessages(sessionId).slice(-MAX_TURNS).map(m => ({ role: m.role, content: m.content }));
  // The model's history must start with a user turn.
  while (history.length && history[0].role !== "user") history.shift();

  // Training data and past coaching sessions, gathered side by side.
  const [context, recall] = await Promise.all([
    buildCoachContext(),
    recallPastAnalyses(text).catch(err => {
      console.warn("[coach] memory recall failed:", err);
      return { memories: [], model: null };
    }),
  ]);
  // The latest weekly report (if this week's), so "let's discuss the report" works.
  const report = latestReport();
  const system = buildCoachSystemPrompt(context.text, recall.memories.map(m => m.document), report ? { week: weekLabel(report.weekStart), content: report.content } : undefined);
  const result = await coachChat(system, history);
  if (!result.ok) {
    // Leave the conversation as it was so the message can be resent.
    deleteMessage(userMsg.id);
    return NextResponse.json({ error: result.error }, { status: 502 });
  }
  const label = coachModelLabel(loadCoachConfig());
  const reply = addMessage(sessionId, "assistant", result.reply, label, recall.memories.map(m => m.id));
  return NextResponse.json({ userMessage: userMsg, reply, recallModel: recall.model });
}
