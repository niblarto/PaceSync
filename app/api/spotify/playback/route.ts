import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { getFreshToken } from "@/lib/tokenStore";

const BASE = "https://api.spotify.com/v1";

// Pause/resume on whatever Spotify device is currently active, plus a GET
// for the current is-playing state (so a UI can show the right play/pause
// icon). Resume here (action=resume) just un-pauses whatever was already
// queued — unlike api/spotify/play/route.ts, which starts a specific
// track from scratch.
export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null) as { action?: string; positionMs?: number } | null;
  const action = body?.action;
  if (action !== "pause" && action !== "resume" && action !== "seek") {
    return NextResponse.json({ error: "action must be 'pause', 'resume', or 'seek'" }, { status: 400 });
  }
  if (action === "seek" && (body?.positionMs === undefined || body.positionMs < 0)) {
    return NextResponse.json({ error: "positionMs required for seek" }, { status: 400 });
  }

  const token = await getFreshToken();
  if (!token.ok) {
    return NextResponse.json({ error: `No Spotify token available (${token.reason})` }, { status: 502 });
  }

  // Spotify's Web API has no PUT /me/player/resume endpoint — resuming
  // whatever was paused is PUT /me/player/play with no body (only /pause
  // has its own dedicated endpoint). Seek is its own endpoint taking the
  // target offset as a query param, not a body.
  const url = action === "seek"
    ? `${BASE}/me/player/seek?position_ms=${Math.round(body!.positionMs!)}`
    : `${BASE}/me/player/${action === "pause" ? "pause" : "play"}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token.token}` },
  });

  if (res.status === 204) {
    return NextResponse.json({ ok: true });
  }
  if (res.status === 404) {
    return NextResponse.json({ error: "No active Spotify device" }, { status: 409 });
  }

  const errText = await res.text().catch(() => "");
  return NextResponse.json({ error: `Spotify ${action} failed (${res.status})`, detail: errText }, { status: 502 });
}

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const token = await getFreshToken();
  if (!token.ok) {
    return NextResponse.json({ error: `No Spotify token available (${token.reason})` }, { status: 502 });
  }

  const res = await fetch(`${BASE}/me/player`, {
    headers: { Authorization: `Bearer ${token.token}` },
  });

  // 204 means no active device/session at all.
  if (res.status === 204) {
    return NextResponse.json({ isPlaying: false, hasDevice: false });
  }
  if (!res.ok) {
    console.log(`[spotify/playback] GET -> Spotify ${res.status} (likely missing user-read-playback-state scope — re-login with Spotify to grant it)`);
    return NextResponse.json({ error: `Spotify player state failed (${res.status})` }, { status: 502 });
  }

  const data = await res.json() as { is_playing?: boolean; progress_ms?: number; item?: { uri?: string; duration_ms?: number } };
  return NextResponse.json({
    isPlaying: !!data.is_playing,
    hasDevice: true,
    trackUri: data.item?.uri ?? null,
    progressMs: data.progress_ms ?? 0,
    durationMs: data.item?.duration_ms ?? 0,
  });
}
