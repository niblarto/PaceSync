import { NextRequest, NextResponse } from "next/server";
import { loadStravaConfig } from "@/lib/strava-config";
import { saveStravaTokens } from "@/lib/strava-tokens";

// Strava redirects here with ?code=... after the user approves access.
// Not gated by getServerSession — Strava's redirect is a plain browser GET
// with no way to carry our session cookie's auth header, but middleware.ts
// already requires local-auth login to reach /strava in the first place,
// and this route only ever writes tokens, never reads app data.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");
  // NEXTAUTH_URL, not request origin — the proxy rewrites Host to localhost
  const base = process.env.NEXTAUTH_URL?.replace(/\/+$/, "") || req.nextUrl.origin;
  const redirectBase = `${base}/strava`;

  if (error) {
    return NextResponse.redirect(`${redirectBase}?error=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return NextResponse.redirect(`${redirectBase}?error=missing_code`);
  }

  const config = loadStravaConfig();
  if (!config) {
    return NextResponse.redirect(`${redirectBase}?error=not_configured`);
  }

  try {
    const res = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) {
      return NextResponse.redirect(`${redirectBase}?error=token_exchange_failed`);
    }
    const data = await res.json() as {
      access_token: string; refresh_token: string; expires_at: number;
      athlete?: { id: number; firstname: string; lastname: string };
    };
    saveStravaTokens({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_at,
      athleteId: data.athlete?.id,
      athleteName: data.athlete ? `${data.athlete.firstname} ${data.athlete.lastname}`.trim() : undefined,
    });
    return NextResponse.redirect(`${redirectBase}?connected=1`);
  } catch {
    return NextResponse.redirect(`${redirectBase}?error=network_error`);
  }
}
