import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadAiDjConfig, saveAiDjConfig } from "@/lib/ai-dj-config";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const config = loadAiDjConfig();
  return NextResponse.json({ url: config?.url ?? "", enabled: config?.enabled ?? false });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { url, enabled } = await req.json() as { url: string; enabled: boolean };
  saveAiDjConfig({ url: url.trim().replace(/\/+$/, ""), enabled: !!enabled });
  return NextResponse.json({ ok: true });
}
