import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { lookupExchangeCode } from "@/lib/spotify-lookup-account";

// Where Spotify sends you back after the secondary lookup account signs in; stores its tokens, then returns to Settings.
// (The path is "spotify-app2" because that is the Redirect URI already registered on the lookup app.)
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const base = (process.env.NEXTAUTH_URL ?? req.nextUrl.origin).replace(/\/$/, "");
  const back = (result: string) => NextResponse.redirect(`${base}/settings?lookupAccount=${encodeURIComponent(result)}`);
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.redirect(`${base}/`);

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const error = req.nextUrl.searchParams.get("error");
  if (error) return back(`error: ${error}`);
  if (!code || !state || state !== req.cookies.get("spotify_lookup_state")?.value) return back("error: sign-in state didn't match, try again");

  const r = await lookupExchangeCode(code);
  const res = back(r.ok ? "connected" : `error: ${r.error}`);
  res.cookies.delete("spotify_lookup_state");
  return res;
}
