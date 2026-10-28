import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { getFreshToken } from "@/lib/tokenStore";
import { deleteWipPlaylist, syncWipPlaylist } from "@/lib/wip-playlist";

// The open dashboard mix's "<name>_WIP" Spotify playlist (see lib/wip-playlist.ts).
// POST { name, trackUris, description? } - create / update it.  DELETE { name } - remove it.

async function token(): Promise<{ ok: true; token: string } | { ok: false; res: NextResponse }> {
  const t = await getFreshToken();
  if (!t.ok) return { ok: false, res: NextResponse.json({ error: `No Spotify token available (${t.reason})` }, { status: 502 }) };
  return { ok: true, token: t.token };
}

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name, trackUris, description } = await req.json().catch(() => ({})) as { name?: string; trackUris?: string[]; description?: string };
  if (!name || !Array.isArray(trackUris) || trackUris.length === 0) return NextResponse.json({ error: "name and trackUris required" }, { status: 400 });
  const t = await token();
  if (!t.ok) return t.res;
  try {
    const out = await syncWipPlaylist(t.token, name, trackUris, description ?? "Work in progress: PaceSync deletes this when the mix is closed or saved.");
    if (out.status === "queued") return NextResponse.json({ queued: true, until: out.until, playlistId: null });
    return NextResponse.json({ playlistId: out.result.playlistId, unchanged: out.unchanged });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "WIP sync failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await req.json().catch(() => ({})) as { name?: string };
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const t = await token();
  if (!t.ok) return t.res;
  try {
    return NextResponse.json({ ok: await deleteWipPlaylist(t.token, name) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "WIP delete failed" }, { status: 500 });
  }
}
