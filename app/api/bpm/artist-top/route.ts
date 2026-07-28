import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

// Deezer's API has no CORS headers, so it can only be called server-side —
// this proxies artist search + top-tracks for the dashboard's "more by this
// artist" button. Spotify's own artists/{id}/top-tracks was removed for apps
// without Extended Access (Nov 2024), same restriction as the deprecated
// /tracks endpoint elsewhere in this app, so Deezer (keyless) stands in;
// results get matched onto Spotify client-side afterward.

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const artistName = req.nextUrl.searchParams.get("artist");
  if (!artistName) return NextResponse.json({ error: "artist required" }, { status: 400 });

  try {
    const ar = await fetch(`https://api.deezer.com/search/artist?q=${encodeURIComponent(artistName)}&limit=25`);
    if (!ar.ok) return NextResponse.json({ error: `Deezer artist search failed (${ar.status})` }, { status: 502 });
    const ad = await ar.json() as { data?: { id: number; name: string }[] };
    const candidates = ad.data ?? [];
    if (candidates.length === 0) return NextResponse.json({ error: `No Deezer artist found for "${artistName}"` }, { status: 404 });

    // Deezer's search is relevance-ranked, not exact — "Hybrid" happily
    // matches "Hybrid Minds" as its #1 result. Require a case-insensitive
    // exact name match (ignoring surrounding whitespace) instead of blindly
    // taking the top relevance hit, so a short/partial query never silently
    // pulls top tracks for a different, longer-named artist.
    const wanted = artistName.trim().toLowerCase();
    const artist = candidates.find(a => a.name.trim().toLowerCase() === wanted);
    if (!artist) {
      return NextResponse.json({ error: `No exact Deezer match for "${artistName}" (closest: "${candidates[0].name}")` }, { status: 404 });
    }

    const tr = await fetch(`https://api.deezer.com/artist/${artist.id}/top?limit=15`);
    if (!tr.ok) return NextResponse.json({ error: `Deezer top tracks failed (${tr.status})` }, { status: 502 });
    const td = await tr.json() as { data?: { title: string; artist: { name: string } }[] };
    let tracks = td.data ?? [];

    // Some artists resolve to a Deezer id whose /top is empty (sparse
    // catalog entry, or search matched a same-named-but-different artist) —
    // fall back to a plain track search for the artist name, ranked by
    // Deezer's own relevance/rank so it's still "popular songs", just via a
    // different endpoint.
    if (tracks.length === 0) {
      const sr = await fetch(`https://api.deezer.com/search?q=artist:"${encodeURIComponent(artist.name)}"&limit=25`);
      if (sr.ok) {
        const sd = await sr.json() as { data?: { title: string; artist: { name: string }; rank?: number }[] };
        tracks = (sd.data ?? [])
          .filter(t => t.artist.name.trim().toLowerCase() === wanted)
          .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
      }
    }

    if (tracks.length === 0) {
      return NextResponse.json({ error: `No top tracks found for "${artistName}" on Deezer` }, { status: 404 });
    }

    return NextResponse.json({ tracks: tracks.map(t => ({ title: t.title, artist: t.artist.name })) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Deezer lookup failed" }, { status: 502 });
  }
}
