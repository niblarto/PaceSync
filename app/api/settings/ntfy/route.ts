import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadNtfyTopic, saveNtfyTopic } from "@/lib/ntfy-config";
import { sendNtfy } from "@/lib/ntfy";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const topic = loadNtfyTopic() ?? process.env.NTFY_TOPIC ?? null;
  return NextResponse.json({ topic });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { topic } = await req.json() as { topic: string };
  saveNtfyTopic(topic);
  return NextResponse.json({ ok: true });
}

// Send a single test notification. Uses the topic from the request body (the
// field's current value, so it can be tested before saving), falling back to
// the saved topic.
export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { topic } = await req.json().catch(() => ({})) as { topic?: string };
  const target = (topic ?? "").trim() || loadNtfyTopic() || process.env.NTFY_TOPIC || "";
  if (!target) return NextResponse.json({ error: "No topic set" }, { status: 400 });

  // Emoji in the title deliberately exercises the UTF-8 JSON publish path —
  // the cron jobs' emoji titles are what silently broke header-based sends.
  const ok = await sendNtfy(
    `Notifications are working — sent ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}.`,
    { title: "🎧 PaceSync test notification", tags: "wave,musical_note", topic: target }
  );
  if (!ok) return NextResponse.json({ error: "Could not publish to ntfy.sh" }, { status: 502 });
  return NextResponse.json({ ok: true, topic: target });
}
