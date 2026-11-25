import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadLocalAuth, verifyPassword, verifyTotp } from "@/lib/local-auth";
import { createApiKey, listApiKeys, recentApiRequests, revokeApiKey } from "@/lib/api-keys";

export const dynamic = "force-dynamic";

// Manage the external API keys (the /api/v1 endpoints). Browser session only (an API key can't manage keys), and creating
// one re-checks the password and authenticator code, the same as the mobile app token.

export async function GET() {
  if (!(await getServerSession(authOptions))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ keys: listApiKeys(), requests: recentApiRequests(30) });
}

export async function POST(req: NextRequest) {
  if (!(await getServerSession(authOptions))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name, username, password, totpCode } = await req.json() as { name?: string; username?: string; password?: string; totpCode?: string };
  if (!username || !password) return NextResponse.json({ error: "Username and password required" }, { status: 400 });
  const config = loadLocalAuth();
  if (!config) return NextResponse.json({ error: "Local auth is not configured on the server" }, { status: 500 });
  if (username.toLowerCase() !== config.username.toLowerCase() || !verifyPassword(password, config)) {
    return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
  }
  if (config.totpEnabled && config.totpSecret) {
    if (!totpCode) return NextResponse.json({ totpRequired: true });
    if (!verifyTotp(config.totpSecret, totpCode)) return NextResponse.json({ error: "Invalid authenticator code" }, { status: 401 });
  }
  const { key, info } = createApiKey(name ?? "");
  return NextResponse.json({ key, info });
}

export async function DELETE(req: NextRequest) {
  if (!(await getServerSession(authOptions))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!revokeApiKey(id)) return NextResponse.json({ error: "No such active key" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
