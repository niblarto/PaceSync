import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { buildCoachContext } from "@/lib/coach-context";
import { coachWebChat } from "@/lib/coach-llm";
import { formatCoachText } from "@/lib/coach-format";
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
    // Assistant replies get the same layout as reports (headings on their own
    // line, one bullet per item), including ones saved before that existed.
    messages: id == null ? [] : getSessionMessages(id).map(m => m.role === "assistant" ? { ...m, content: formatCoachText(m.content, { splitHeadings: true }) } : m),
    model: coachModelLabel(loadCoachConfig()),
  });
}

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // web: the 🌐 button, answered by Gemini with Google Search.
  const { message, web } = await req.json() as { message?: string; web?: boolean };
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
  const result = web ? await coachWebChat(system, history) : await coachChat(system, history);
  if (!result.ok) {
    // Leave the conversation as it was so the message can be resent.
    deleteMessage(userMsg.id);
    return NextResponse.json({ error: result.error }, { status: 502 });
  }
  const label = result.model || coachModelLabel(loadCoachConfig());
  // Web answers end with their sources as links.
  let content = formatCoachText(result.reply, { splitHeadings: true });
  if (result.note) content = `_${result.note}_\n\n${content}`;
  if (result.sources?.length) {
    content += `\n\n**Sources**\n${result.sources.slice(0, 8).map(s => `- [${s.title.replace(/[\[\]]/g, "")}](${s.url})`).join("\n")}`;
  }
  const reply = addMessage(sessionId, "assistant", content, label, recall.memories.map(m => m.id));
  return NextResponse.json({ userMessage: userMsg, reply, recallModel: recall.model });
}
