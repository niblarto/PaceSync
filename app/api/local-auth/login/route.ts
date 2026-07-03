import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE, AUTH_MAX_AGE_SEC,
  createAuthToken, loadLocalAuth, verifyPassword, verifyTotp,
} from "@/lib/local-auth";

// Simple in-process throttle: 5 failures per IP → 60s lockout.
const attempts = new Map<string, { count: number; lockedUntil: number }>();
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60_000;

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const entry = attempts.get(ip);
  if (entry && entry.lockedUntil > Date.now()) {
    const wait = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
    return NextResponse.json({ error: `Too many attempts — try again in ${wait}s` }, { status: 429 });
  }

  const { username, password, code } = await req.json() as {
    username?: string; password?: string; code?: string;
  };

  const config = loadLocalAuth();
  if (!config) {
    return NextResponse.json({ error: "Local auth is not configured on the server" }, { status: 500 });
  }

  const fail = (error: string, status = 401) => {
    const e = attempts.get(ip) ?? { count: 0, lockedUntil: 0 };
    e.count += 1;
    if (e.count >= MAX_FAILURES) {
      e.lockedUntil = Date.now() + LOCKOUT_MS;
      e.count = 0;
    }
    attempts.set(ip, e);
    return NextResponse.json({ error }, { status });
  };

  if (!username || !password) return fail("Username and password required", 400);
  if (username.toLowerCase() !== config.username.toLowerCase() || !verifyPassword(password, config)) {
    return fail("Invalid username or password");
  }

  if (config.totpEnabled && config.totpSecret) {
    if (!code) {
      // Credentials fine — ask the client to show the TOTP field. Not a failure.
      return NextResponse.json({ totpRequired: true });
    }
    if (!verifyTotp(config.totpSecret, code)) {
      return fail("Invalid authenticator code");
    }
  }

  attempts.delete(ip);
  const token = await createAuthToken(config.username);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_MAX_AGE_SEC,
  });
  return res;
}
