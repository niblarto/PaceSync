import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadStravaConfig } from "@/lib/strava-config";

// Kicks off the Strava OAuth handshake — redirects the browser to Strava's
// authorize screen. The redirect_uri base comes from NEXTAUTH_URL (the app's
// public URL), NOT the request origin: behind the tunnel/proxy the incoming
// Host header is rewritten to localhost:5005, which would send Strava's
// redirect to the user's own machine instead of the app.
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const config = loadStravaConfig();
  if (!config) return NextResponse.json({ error: "Strava not configured — set Client ID/Secret in Settings first" }, { status: 400 });

  const base = process.env.NEXTAUTH_URL?.replace(/\/+$/, "") || req.nextUrl.origin;
  const redirectUri = `${base}/api/strava/callback`;
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    approval_prompt: "force",
    scope: "read,activity:read_all,activity:write,profile:read_all",
  });
  return NextResponse.redirect(`https://www.strava.com/oauth/authorize?${params}`);
}
