import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

// Gates the app pages and the Spotify OAuth endpoints behind the local
// username/password (+TOTP) login. The cookie is a JWT signed with
// NEXTAUTH_SECRET, issued by /api/local-auth/login.
//
// Not gated: the landing page, /login itself, /api/local-auth/*, static
// assets, and /api/cron/* (protected by X-Cron-Secret, called from localhost).

const AUTH_COOKIE = "pacesync_auth";

async function hasValidLocalAuth(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(AUTH_COOKIE)?.value;
  if (!token) return false;
  try {
    const secret = new TextEncoder().encode(process.env.NEXTAUTH_SECRET);
    const { payload } = await jwtVerify(token, secret);
    return payload.scope === "local-auth";
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  if (await hasValidLocalAuth(req)) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/settings/:path*",
    "/garmin/:path*",
    "/strava/:path*",
    "/api/auth/signin/:path*",
    "/api/auth/callback/:path*",
  ],
};
