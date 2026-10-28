import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { lookupAppConfigured, lookupAuthorizeUrl } from "@/lib/spotify-lookup-account";
import { randomBytes } from "crypto";

// Starts signing the SECONDARY Spotify account in on the lookup app (Settings > Integrations).
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!lookupAppConfigured()) {
    return NextResponse.json({ error: "Enter the lookup app's client id and secret in Settings first." }, { status: 400 });
  }
  const state = randomBytes(16).toString("hex");
  const res = NextResponse.redirect(lookupAuthorizeUrl(state));
  res.cookies.set("spotify_lookup_state", state, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/" });
  return res;
}
