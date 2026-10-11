import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { getFreshToken } from "@/lib/tokenStore";

const BASE = "https://api.spotify.com/v1";

// Starts playback of a track on the user's currently-active Spotify
// device via the Web API's player controls, rather than launching the
// Spotify app's own UI — so Spotify keeps playing in the background while
// PaceSync stays in the foreground on the phone. Requires an already-open
// Spotify session on some device (phone, desktop, speaker, etc.) — the Web
// API can't launch the app itself, only command an existing session.
export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null) as { uri?: string } | null;
  const uri = body?.uri;
  if (!uri || !uri.startsWith("spotify:track:")) {
    return NextResponse.json({ error: "uri (spotify:track:<id>) required" }, { status: 400 });
  }

  const token = await getFreshToken();
  if (!token.ok) {
    return NextResponse.json({ error: `No Spotify token available (${token.reason})` }, { status: 502 });
  }

  const res = await fetch(`${BASE}/me/player/play`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ uris: [uri] }),
  });

  if (res.status === 204) {
    return NextResponse.json({ ok: true });
  }

  // 404 means no active device — Spotify must be open somewhere already
  // (the Web API has no way to launch the app remotely).
  if (res.status === 404) {
    return NextResponse.json({ error: "No active Spotify device — open Spotify on any device first" }, { status: 409 });
  }

  const errText = await res.text().catch(() => "");
  return NextResponse.json({ error: `Spotify playback failed (${res.status})`, detail: errText }, { status: 502 });
}
