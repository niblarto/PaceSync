import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadLocalAuth, verifyPassword, verifyTotp } from "@/lib/local-auth";
import { createMobileToken } from "@/lib/mobile-auth";

// Mints a long-lived (1 year) bearer token for the Android companion app —
// shown once in Settings, never retrievable again, so losing it just means
// generating a new one (old tokens stay valid until their own expiry; there
// is no revocation list, same tradeoff as the local-auth cookie token).
//
// Gated behind BOTH an existing web session (so this can't be hit cold from
// the internet with nothing but guessed credentials) AND a fresh
// password+TOTP check (so a logged-in browser tab left open on a shared
// machine can't mint a durable API credential on its own) — same
// defense-in-depth shape as the page middleware + per-route session checks
// already used elsewhere.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { username, password, totpCode } = await req.json() as {
    username?: string; password?: string; totpCode?: string;
  };
  if (!username || !password) {
    return NextResponse.json({ error: "Username and password required" }, { status: 400 });
  }

  const config = loadLocalAuth();
  if (!config) return NextResponse.json({ error: "Local auth is not configured on the server" }, { status: 500 });

  if (username.toLowerCase() !== config.username.toLowerCase() || !verifyPassword(password, config)) {
    return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
  }

  if (config.totpEnabled && config.totpSecret) {
    if (!totpCode) return NextResponse.json({ totpRequired: true });
    if (!verifyTotp(config.totpSecret, totpCode)) {
      return NextResponse.json({ error: "Invalid authenticator code" }, { status: 401 });
    }
  }

  const token = await createMobileToken();
  return NextResponse.json({ token });
}
