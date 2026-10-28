import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requestPlaylistSave } from "@/lib/spotify-outbox";
import { hasApiAccess } from "@/lib/mobile-auth";
import { getFreshToken } from "@/lib/tokenStore";

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Browser sessions carry their own Spotify token; the Android app has
  // none, so fall back to the server's stored one.
  const session = await getServerSession(authOptions);
  let token = session?.accessToken;
  if (!token) {
    const stored = await getFreshToken();
    if (!stored.ok) return NextResponse.json({ error: `No Spotify token available (${stored.reason})` }, { status: 502 });
    token = stored.token;
  }

  const { name, description, trackUris } = await req.json() as {
    name: string;
    description: string;
    trackUris: string[];
  };

  if (!name || !trackUris?.length) {
    return NextResponse.json({ error: "name and trackUris required" }, { status: 400 });
  }

  try {
    console.log(`[create-playlist] name="${name}" tracks=${trackUris.length}`);

    const out = await requestPlaylistSave(token, { name, description: description ?? "", uris: trackUris });
    if (out.status === "queued") {
      // Spotify is rate-limiting: the caller has already saved locally; the playlist is sent when the limit clears.
      return NextResponse.json({
        queued: true, until: out.until, playlistId: null, url: null, tracksAdded: false,
        message: `Saved in PaceSync. Spotify is rate-limiting, so the "${name}" playlist will be created automatically${out.until ? ` after about ${new Date(out.until).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : " when Spotify allows"}.`,
      });
    }
    const result = out.result;
    if (result.replaced) {
      console.log(`[create-playlist] found existing playlist ${result.playlistId} — replaced tracks`);
    } else {
      console.log(`[create-playlist] created ${result.playlistId}`);
    }
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[create-playlist] error: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
