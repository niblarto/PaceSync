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

  // Either a single track (uri) or a whole playlist (contextUri). A
  // playlist always plays from track 1 with shuffle off, so the tracklist
  // runs in its built order.
  const body = await req.json().catch(() => null) as { uri?: string; contextUri?: string } | null;
  const uri = body?.uri;
  const contextUri = body?.contextUri;
  const isPlaylist = !!contextUri?.startsWith("spotify:playlist:");
  if (!isPlaylist && !uri?.startsWith("spotify:track:")) {
    return NextResponse.json({ error: "uri (spotify:track:<id>) or contextUri (spotify:playlist:<id>) required" }, { status: 400 });
  }

  const token = await getFreshToken();
  if (!token.ok) {
    return NextResponse.json({ error: `No Spotify token available (${token.reason})` }, { status: 502 });
  }
  const auth = { Authorization: `Bearer ${token.token}` };
  // Best-effort — fails harmlessly (404) when no device is active yet.
  const shuffleOff = () => fetch(`${BASE}/me/player/shuffle?state=false`, { method: "PUT", headers: auth }).catch(() => null);

  // A single track is started as "this track, from its album" rather than as a bare
  // `uris: [track]`. Spotify answers 204 to the bare form, but the phone's app has
  // been stopping the current song and never starting the new one (measured: the
  // bare form with or without a device id did nothing; the album context played).
  // If the album can't be looked up, fall back to the bare form.
  let albumUri: string | null = null;
  if (!isPlaylist) {
    const trackId = uri!.split(":")[2];
    const tr = await fetch(`${BASE}/tracks/${trackId}?market=from_token`, { headers: auth })
      .then(r => (r.ok ? r.json() : null)).catch(() => null) as { album?: { uri?: string } } | null;
    albumUri = tr?.album?.uri ?? null;
  }
  const asContext = isPlaylist || albumUri != null;

  // Context plays follow the device's shuffle setting, which would pick a random
  // track instead of the one asked for - so shuffle is switched off first.
  if (asContext) await shuffleOff();
  const res = await fetch(`${BASE}/me/player/play`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(
      isPlaylist ? { context_uri: contextUri, offset: { position: 0 } }
        : albumUri ? { context_uri: albumUri, offset: { uri } }
        : { uris: [uri] },
    ),
  });
  // Spotify can re-apply the device's shuffle setting as a new context
  // starts — turn it off again once playback is running.
  if (asContext && res.status === 204) await shuffleOff();

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
