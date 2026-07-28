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

// Phones hitting the desktop dashboard get bounced to the separate mobile
// dashboard (/mobile) instead. Tablets are deliberately excluded (iPad's UA
// contains "Mobile" on some iOS versions, so iPad is matched explicitly
// before the generic mobile check to make sure it's never caught) — they
// keep using the desktop 3-column layout, same as PCs.
const TABLET_UA_RE = /iPad|Tablet|(?:Android(?!.*Mobile))/i;
const MOBILE_UA_RE = /iPhone|iPod|Android.*Mobile|Windows Phone|BlackBerry|Mobile.*Firefox/i;

function isMobileUserAgent(ua: string): boolean {
  if (TABLET_UA_RE.test(ua)) return false;
  return MOBILE_UA_RE.test(ua);
}

export async function middleware(req: NextRequest) {
  if (!(await hasValidLocalAuth(req))) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (req.nextUrl.pathname.startsWith("/dashboard") && isMobileUserAgent(req.headers.get("user-agent") ?? "")) {
    const url = req.nextUrl.clone();
    url.pathname = "/mobile";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/mobile/:path*",
    "/settings/:path*",
    "/garmin/:path*",
    "/strava/:path*",
    "/api/auth/signin/:path*",
    "/api/auth/callback/:path*",
  ],
};
