import { SignJWT, jwtVerify } from "jose";
import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

// Bearer-token auth for the Android companion app, which has no browser to
// hold the NextAuth session cookie every JSON API route otherwise checks.
// Signed with the same NEXTAUTH_SECRET as lib/local-auth.ts's own cookie
// JWT (same primitive, different scope string) — minted once via
// app/api/settings/mobile-token/route.ts (which re-verifies password+TOTP
// before minting, same as a fresh login) and pasted into the app, sent back
// as `Authorization: Bearer <token>` on every request.
//
// 1 year, not infinite — long enough that a sideloaded personal app never
// needs re-pasting in normal use, short enough that a lost/leaked token
// doesn't stay valid forever. There's no revocation list (same as the
// local-auth cookie token); regenerating just mints a new token, any old one
// stays valid until its own expiry.

const MOBILE_SCOPE = "mobile-api";
const MOBILE_TOKEN_MAX_AGE_SEC = 365 * 24 * 60 * 60;

function jwtSecret(): Uint8Array {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET not set");
  return new TextEncoder().encode(secret);
}

export async function createMobileToken(): Promise<string> {
  return new SignJWT({ scope: MOBILE_SCOPE })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MOBILE_TOKEN_MAX_AGE_SEC}s`)
    .sign(jwtSecret());
}

async function verifyMobileBearer(req: NextRequest): Promise<boolean> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, jwtSecret());
    return payload.scope === MOBILE_SCOPE;
  } catch {
    return false;
  }
}

// Drop-in replacement for the repeated
//   const session = await getServerSession(authOptions);
//   if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
// pattern on every JSON API route the Android app calls — true if EITHER a
// valid NextAuth (browser) session OR a valid mobile bearer token is
// present. Callers keep their own 401 response so the diff at each call
// site stays a one-line condition swap.
export async function hasApiAccess(req: NextRequest): Promise<boolean> {
  if (await verifyMobileBearer(req)) return true;
  const session = await getServerSession(authOptions);
  return !!session;
}
