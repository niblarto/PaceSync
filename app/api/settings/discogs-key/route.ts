import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadDiscogsConfig, saveDiscogsConfig } from "@/lib/discogs-config";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const config = loadDiscogsConfig();
  return NextResponse.json({ configured: !!config?.apiToken });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { apiToken } = await req.json() as { apiToken?: string };
  if (!apiToken?.trim()) return NextResponse.json({ error: "apiToken required" }, { status: 400 });

  try {
    saveDiscogsConfig({ apiToken: apiToken.trim() });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to save token: ${msg}` }, { status: 500 });
  }
}
