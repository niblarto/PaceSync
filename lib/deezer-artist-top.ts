// Deezer artist top-tracks + ISRC resolution — shared by /api/bpm/artist-top
// ("more by this artist" button) and /api/tracks/replace-candidates (the mix
// track-replace picker's online top-up). Deezer's API has no CORS headers,
// so this only runs server-side. Spotify's own artists/{id}/top-tracks was
// removed for apps without Extended Access (Nov 2024), so Deezer (keyless)
// stands in; each track's ISRC is fetched too so a result can be added
// without ever calling Spotify's Search API — see the callers for why that
// matters (a confirmed real Spotify rate-limit ban).

export interface DeezerArtistTrack {
  title: string;
  artist: string;
  isrc: string | null;
  durationMs: number | null;
}

export type DeezerArtistTopResult =
  | { ok: true; tracks: DeezerArtistTrack[] }
  | { ok: false; error: string };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function deezerArtistTopTracks(artistName: string, includeRelated: boolean, topLimit = 15): Promise<DeezerArtistTopResult> {
  const ar = await fetch(`https://api.deezer.com/search/artist?q=${encodeURIComponent(artistName)}&limit=25`);
  if (!ar.ok) return { ok: false, error: `Deezer artist search failed (${ar.status})` };
  const ad = await ar.json() as { data?: { id: number; name: string }[] };
  const candidates = ad.data ?? [];
  if (candidates.length === 0) return { ok: false, error: `No Deezer artist found for "${artistName}"` };

  // Deezer's search is relevance-ranked, not exact — "Hybrid" happily
  // matches "Hybrid Minds" as its #1 result. Require a case-insensitive
  // exact name match (ignoring surrounding whitespace) instead of blindly
  // taking the top relevance hit, so a short/partial query never silently
  // pulls top tracks for a different, longer-named artist.
  const wanted = artistName.trim().toLowerCase();
  const artist = candidates.find(a => a.name.trim().toLowerCase() === wanted);
  if (!artist) {
    return { ok: false, error: `No exact Deezer match for "${artistName}" (closest: "${candidates[0].name}")` };
  }

  // topLimit defaults to 15 (the original, cheap "related artists + a few
  // tracks each" case), but a caller doing one deliberate, explicit
  // single-artist search wants the artist's FULL Deezer top list (its /top
  // endpoint tops out around 50) — confirmed live: a 168 BPM search against
  // Teebee's catalog had its one real match ("Cherokee") sitting at
  // position #39, unreachable at the old fixed limit=15.
  const tr = await fetch(`https://api.deezer.com/artist/${artist.id}/top?limit=${topLimit}`);
  if (!tr.ok) return { ok: false, error: `Deezer top tracks failed (${tr.status})` };
  const td = await tr.json() as { data?: { id: number; title: string; artist: { name: string } }[] };
  let tracks = td.data ?? [];

  // Some artists resolve to a Deezer id whose /top is empty (sparse catalog
  // entry, or search matched a same-named-but-different artist) — fall back
  // to a plain track search for the artist name, ranked by Deezer's own
  // relevance/rank so it's still "popular songs", just via a different
  // endpoint.
  if (tracks.length === 0) {
    const sr = await fetch(`https://api.deezer.com/search?q=artist:"${encodeURIComponent(artist.name)}"&limit=${Math.max(topLimit, 25)}`);
    if (sr.ok) {
      const sd = await sr.json() as { data?: { id: number; title: string; artist: { name: string }; rank?: number }[] };
      tracks = (sd.data ?? [])
        .filter(t => t.artist.name.trim().toLowerCase() === wanted)
        .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
    }
  }

  if (tracks.length === 0 && !includeRelated) {
    return { ok: false, error: `No top tracks found for "${artistName}" on Deezer` };
  }

  // Related-artist top tracks — mirrors bpm_matcher/sources.py's
  // deezer_related_artist_tracks (Python's own version of this, used by the
  // style/tempo suggest pipeline).
  const relatedTracks: { title: string; artist: { name: string }; id: number }[] = [];
  if (includeRelated) {
    try {
      const rr = await fetch(`https://api.deezer.com/artist/${artist.id}/related?limit=5`);
      if (rr.ok) {
        const rd = await rr.json() as { data?: { id: number; name: string }[] };
        for (const rel of (rd.data ?? []).slice(0, 5)) {
          await sleep(120);
          const rtr = await fetch(`https://api.deezer.com/artist/${rel.id}/top?limit=5`);
          if (!rtr.ok) continue;
          const rtd = await rtr.json() as { data?: { id: number; title: string; artist: { name: string } }[] };
          relatedTracks.push(...(rtd.data ?? []));
        }
      }
    } catch { /* best-effort — related-artist tracks are a supplement, not required */ }
  }

  const allTracks = [...tracks, ...relatedTracks];
  if (allTracks.length === 0) {
    return { ok: false, error: `No top tracks found for "${artistName}" on Deezer` };
  }

  // Sequential + a small gap, same politeness convention as every other
  // Deezer loop in this app (lib/track-enrich.ts sleeps 150ms between Deezer
  // calls) — Deezer's own rate limit is 50 req/5s, generous, but there's no
  // reason to burst it.
  const withIsrc: DeezerArtistTrack[] = [];
  // Dedupe (title, artist) — related-artist top-N calls can genuinely
  // repeat an artist across "related to related" overlaps.
  const seen = new Set<string>();
  for (const t of allTracks) {
    const key = `${t.artist.name.trim().toLowerCase()}::${t.title.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (withIsrc.length > 0) await sleep(120);
    let isrc: string | null = null;
    let durationMs: number | null = null;
    try {
      const dr = await fetch(`https://api.deezer.com/track/${t.id}`);
      if (dr.ok) {
        const dd = await dr.json() as { isrc?: string; duration?: number };
        isrc = dd.isrc ?? null;
        durationMs = typeof dd.duration === "number" ? dd.duration * 1000 : null;
      }
    } catch { /* best-effort — track still usable without an ISRC/duration below */ }
    withIsrc.push({ title: t.title, artist: t.artist.name, isrc, durationMs });
  }

  return { ok: true, tracks: withIsrc };
}
