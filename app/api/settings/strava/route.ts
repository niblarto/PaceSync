import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadStravaConfig, saveStravaConfig } from "@/lib/strava-config";
import { loadStravaTokens } from "@/lib/strava-tokens";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const config = loadStravaConfig();
  const tokens = loadStravaTokens();
  return NextResponse.json({
    clientId: config?.clientId ?? "",
    hasSecret: !!config?.clientSecret,
    connected: !!tokens,
    athleteName: tokens?.athleteName ?? null,
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { clientId, clientSecret } = await req.json() as { clientId?: string; clientSecret?: string };
  const existing = loadStravaConfig();
  const nextClientId = (clientId ?? "").trim() || existing?.clientId || "";
  const nextClientSecret = (clientSecret ?? "").trim() || existing?.clientSecret || "";
  if (!nextClientId || !nextClientSecret) {
    return NextResponse.json({ error: "Client ID and secret are both required" }, { status: 400 });
  }
  saveStravaConfig({ clientId: nextClientId, clientSecret: nextClientSecret });
  return NextResponse.json({ ok: true });
}
