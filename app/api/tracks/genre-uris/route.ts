import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readAllTracks } from "@/lib/tracks-store";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";

// Same genre parsing as /api/tracks/genres (kept as its own small copy for
// the same reason — see that route's own comment).
function parseGenres(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(",").map(g => g.trim().toLowerCase()).filter(Boolean);
}

// GET ?genre=<tag> — every library track tagged with this one genre, full
// info (not just URIs) — the Dashboard "Remix by genre" picker's "expand a
// genre to see/play/select/delete its tracks" panel.
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const genre = (req.nextUrl.searchParams.get("genre") ?? "").trim().toLowerCase();
  if (!genre) return NextResponse.json({ error: "genre required" }, { status: 400 });

  try {
    const rows = readAllTracks(loadRunningPlaylistConfig().csvFile);
    const tracks = rows
      .filter(t => t.uri && parseGenres(t.genres).includes(genre))
      .map(t => ({
        uri: t.uri!,
        name: t.trackName ?? "",
        artist: t.artistNames ?? "",
        durationMs: t.durationMs,
        tempo: t.tempo,
        energy: t.energy,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ tracks });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to look up genre tracks" }, { status: 500 });
  }
}

// Library track URIs tagged with at least one of the given genres — feeds
// the AI DJ mix build's segmentCandidateUris (see lib/ai-dj-mix.ts's
// buildAiDjMix doc comment), restricting the remix's candidate pool to
// only the selected genres instead of the whole library.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { genres } = await req.json() as { genres?: string[] };
  if (!genres?.length) return NextResponse.json({ error: "genres required" }, { status: 400 });
  const wanted = new Set(genres.map(g => g.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) return NextResponse.json({ error: "genres required" }, { status: 400 });

  try {
    const rows = readAllTracks(loadRunningPlaylistConfig().csvFile);
    const uris = rows
      .filter(t => t.uri && parseGenres(t.genres).some(g => wanted.has(g)))
      .map(t => t.uri!);
    return NextResponse.json({ uris });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to look up genre tracks" }, { status: 500 });
  }
}
