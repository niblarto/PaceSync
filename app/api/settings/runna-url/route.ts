import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadRunnaUrl, saveRunnaUrl } from "@/lib/runna-config";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const icsUrl = loadRunnaUrl() ?? process.env.RUNNA_ICS_URL ?? null;
  return NextResponse.json({ icsUrl });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { icsUrl } = await req.json() as { icsUrl: string };
  saveRunnaUrl(icsUrl);
  return NextResponse.json({ ok: true });
}
