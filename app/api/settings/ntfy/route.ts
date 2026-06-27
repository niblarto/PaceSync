import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadNtfyTopic, saveNtfyTopic } from "@/lib/ntfy-config";

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
