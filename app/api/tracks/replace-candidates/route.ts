import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readAllTracks } from "@/lib/tracks-store";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { resolveByIsrc, sleep } from "@/lib/track-enrich";
import { deezerArtistTopTracks } from "@/lib/deezer-artist-top";
import { artistsSharingGenre, parseGenres } from "@/lib/genre-artists";
import { discogsArtistsForGenre } from "@/lib/discogs-artist-search";
import { energyInBand, type EnergyBand } from "@/lib/energy-bands";

// Candidates to swap in for one track in a mix, by target BPM — Dashboard's
// ♻ "replace by BPM" button. BPM match is exact, not closest-available: a
// candidate only qualifies (library or online) if its BPM ROUNDS to exactly
// the specified target, half/double-time aware — nothing within a
// tolerance, nothing off by even 1 BPM. "Exact" is judged on the rounded
// value (the same whole-number BPM shown everywhere else in this app, e.g.
// "174 BPM") rather than literal floating-point equality, since the
// library's own Tempo column is rarely a clean integer.
// Library is searched first, topped up with the replaced track's own +
// related artists' songs from Deezer (also exact-BPM-filtered) only if the
// library alone doesn't reach MAX_RESULTS — an online lookup this app
// doesn't need is one it shouldn't make (same reasoning as every other
// Deezer/Spotify call here being deliberately rationed after past
// rate-limit incidents).
//
// Every candidate must ALSO fall within DURATION_TOLERANCE_SEC of the
// original track's own length — a swap substitutes one track for another in
// place with no rebalancing step afterward, so a big duration mismatch
// silently drifts every later track's start time and can shorten the whole
// mix. Within the BPM+duration-qualified pool, results are ordered by
// duration closeness to the original (the secondary, presentation-only
// ranking) — exact BPM match is what decided who's even in the pool.

const MAX_RESULTS = 15;
const DOUBLETIME_THRESHOLD = 95; // mirrors lib/pace-analysis.ts / MixPaceChart
const DURATION_TOLERANCE_SEC = 15;
// Hard cap on how many DIFFERENT artists' Deezer catalogs get searched in
// one online top-up — each is its own sequential (own-top-tracks + related-
// top-tracks) fetch, on top of every candidate's own ReccoBeats resolution,
// so letting this grow unbounded (previously: own artist + up to 5 genre-
// sharing artists, searched exhaustively one after another) made a single
// search visibly churn through many artists before finishing.
const MAX_ARTISTS_SEARCHED = 10;
// Hard cap on total individual track BPM resolutions (ReccoBeats calls) in
// one online top-up, across every artist searched — each resolution is its
// own sequential network round-trip, so even several popular artists' full
// top-tracks lists could otherwise run into the hundreds before giving up.
// Doesn't apply to an explicit single-artist search (searchMode "artist")
// — see the online top-up block below for why that case checks the whole
// catalog regardless of this cap.
const MAX_TRACKS_SEARCHED = 200;
// Genre search's artists are picked automatically (Discogs credits or the
// library's own genre-sharing heuristic), not chosen by the user the way
// "search by artist" is — so once an artist's first few tracks have been
// checked without filling the result list, move on to the next artist
// rather than exhausting one artist's whole top-tracks + related-artists
// catalog before trying another.
const MAX_TRACKS_PER_ARTIST_IN_GENRE_MODE = 5;

function bpmDistance(tempo: number, targetBpm: number): number {
  const candidates = [tempo, tempo * 2, tempo / 2];
  return Math.min(...candidates.map(c => Math.abs(c - targetBpm)));
}

// True only when tempo (half/double-time aware) rounds to exactly targetBpm.
function isExactBpm(tempo: number, targetBpm: number): boolean {
  const candidates = [tempo, tempo * 2, tempo / 2];
  return candidates.some(c => Math.round(c) === Math.round(targetBpm));
}

function effectiveTempo(tempo: number): number {
  return tempo < DOUBLETIME_THRESHOLD ? tempo * 2 : tempo;
}

export interface ReplaceCandidate {
  source: "library" | "online";
  uri: string | null; // null for an online candidate not yet resolved to a Spotify URI
  name: string;
  artist: string;
  tempo: number;
  effectiveBpm: number;
  durationMs: number | null;
  isrc: string | null; // set for an online candidate, so it can be added the same way "more by this artist" does
  key: number | null;
  mode: number | null;
  energy: number | null;
  danceability: number | null;
  valence: number | null;
  genres: string | null; // library candidates only — Deezer's online top-up has no genre data to offer
}

// SSE: streams {"type":"progress","current","total","name"} for each online
// candidate resolved (the library scan itself is instant), then
// {"type":"done","candidates"} or {"type":"error"} — same shape as
// replace-candidates-budget/route.ts's own stream.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as {
    targetBpm?: number; artistName?: string; targetUri?: string; excludeUris?: string[]; originalDurationMs?: number;
    /** Explicit override for what the online top-up searches by, from the
        picker's "search by artist/genre" control — when given, this is used
        INSTEAD of the automatic "replaced track's own artist + genre-sharing
        artists" default. searchMode "artist": searchValue is one artist
        name, searched alone (no automatic genre expansion added on top —
        the user picked a specific artist on purpose). searchMode "genre":
        searchValue is one genre tag, and every library artist carrying that
        tag (up to MAX_ARTISTS_SEARCHED) is searched — the counterpart to
        artistsSharingGenre's usual "tags from the replaced track" input,
        just driven by a user-picked genre instead. */
    searchMode?: "artist" | "genre"; searchValue?: string;
    /** Picker's "force online lookup" toggle — see replace-candidates-
        budget/route.ts's own copy of this field for the full explanation. */
    forceOnline?: boolean;
    /** Optional Low/Medium/High energy filter, on top of the exact-BPM
        match — see lib/energy-bands.ts. */
    energyBand?: EnergyBand;
  };
  const targetBpm = body.targetBpm;
  if (!targetBpm || targetBpm <= 0) return NextResponse.json({ error: "targetBpm required" }, { status: 400 });
  const originalDurationMs = body.originalDurationMs;
  // Every track already in the mix (not just the one being replaced) — a
  // candidate matching one of these would land as a duplicate in the
  // tracklist if picked.
  const excludeUris = new Set(body.excludeUris ?? []);
  // No original length to compare against at all -> don't filter blind. But
  // once we DO have one, a candidate with an unknown length of its own is
  // excluded rather than let through — an online candidate whose duration
  // Deezer's lookup failed to return is exactly the kind of unchecked
  // mismatch this tolerance exists to catch.
  const durationOk = (ms: number | null) =>
    originalDurationMs == null ? true : ms != null && Math.abs(ms - originalDurationMs) <= DURATION_TOLERANCE_SEC * 1000;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: hb\n\n`)); } catch { /* stream closed */ }
      }, 15000);
      try {
        controller.enqueue(encoder.encode(`: ${"x".repeat(1024)}\n\n`));

        const allRows = readAllTracks(loadRunningPlaylistConfig().csvFile);

        // ── Library search ──────────────────────────────────────────
        // Same genre/artist-consistency fix as replace-candidates-budget/
        // route.ts: an explicit "search by artist/genre" override must
        // constrain which LIBRARY candidates qualify too, not just which
        // artists get searched online — otherwise any exact-BPM/duration
        // library track of any artist/genre still shows up in the results
        // list (confirmed: an explicit "Sub Focus" artist override still
        // returned whatever-artist library matches, since only the online
        // top-up ever respected it, and that never ran because the
        // unfiltered library pool alone already reached MAX_RESULTS).
        // forceOnline skips the library entirely for this override — see
        // that field's own doc comment above.
        const genreFilter = body.searchMode === "genre" && body.searchValue
          ? body.searchValue.trim().toLowerCase()
          : null;
        const artistFilter = body.searchMode === "artist" && body.searchValue
          ? body.searchValue.trim().toLowerCase()
          : null;
        const rows = body.forceOnline
          ? []
          : allRows
            .filter(t => t.uri && !excludeUris.has(t.uri) && t.tempo != null && t.durationMs != null && durationOk(t.durationMs))
            .filter(t => !genreFilter || (t.genres ?? "").toLowerCase().includes(genreFilter))
            .filter(t => !artistFilter || (t.artistNames ?? "").toLowerCase().includes(artistFilter))
            .filter(t => !body.energyBand || (t.energy != null && energyInBand(t.energy, body.energyBand)));

        const libraryCandidates: ReplaceCandidate[] = rows
          .map(t => ({
            source: "library" as const,
            uri: t.uri,
            name: t.trackName ?? "",
            artist: t.artistNames ?? "",
            tempo: t.tempo!,
            effectiveBpm: effectiveTempo(t.tempo!),
            durationMs: t.durationMs,
            isrc: t.isrc,
            key: t.key,
            mode: t.mode,
            energy: t.energy,
            danceability: t.danceability,
            valence: t.valence,
            genres: t.genres,
            _dist: bpmDistance(t.tempo!, targetBpm),
          }))
          .filter(t => isExactBpm(t.tempo, targetBpm))
          .sort((a, b) => a._dist - b._dist)
          .slice(0, MAX_RESULTS)
          .map(({ _dist, ...c }) => c);

        const results: ReplaceCandidate[] = [...libraryCandidates];

        // ── Online top-up (Deezer) ────────────────────────────────────
        // Only when the library alone didn't fill the list. Which artists
        // get searched (capped at MAX_ARTISTS_SEARCHED total):
        //  - Explicit "search by artist" override: just that one artist.
        //  - Explicit "search by genre" override: every library artist
        //    tagged with that exact genre (see lib/genre-artists.ts — this
        //    is "genre picks artists to search", not a real genre-filtered
        //    track search, since Deezer has no such API).
        //  - No override (the original automatic behavior): the replaced
        //    track's own artist first, then other library artists sharing
        //    at least one of ITS genre tags, up to the cap.
        const canSearchOnline = body.searchMode
          ? !!body.searchValue
          : !!body.artistName;
        if (results.length < MAX_RESULTS && canSearchOnline) {
          send({ type: "online-start" });
          try {
            let artistNames: string[];
            if (body.searchMode === "artist" && body.searchValue) {
              artistNames = [body.searchValue];
            } else if (body.searchMode === "genre" && body.searchValue) {
              // Discogs first — real genre/style-tagged release data, not
              // limited to artists already in this library. Falls back to
              // the library-only heuristic if no Discogs token is
              // configured (Settings > Integrations) or it finds nothing.
              artistNames = await discogsArtistsForGenre(body.searchValue, MAX_ARTISTS_SEARCHED);
              if (artistNames.length === 0) {
                const seedGenres = new Set([body.searchValue.trim().toLowerCase()]);
                artistNames = artistsSharingGenre(allRows, seedGenres, [], MAX_ARTISTS_SEARCHED);
              }
            } else {
              const targetRow = body.targetUri ? allRows.find(t => t.uri === body.targetUri) : undefined;
              const seedGenres = parseGenres(targetRow?.genres ?? null);
              const genreArtists = artistsSharingGenre(allRows, seedGenres, body.artistName!, MAX_ARTISTS_SEARCHED - 1);
              artistNames = [body.artistName!, ...genreArtists];
            }
            artistNames = artistNames.slice(0, MAX_ARTISTS_SEARCHED);

            const existingUris = new Set(rows.map(t => t.uri));
            const seenKeys = new Set(libraryCandidates.map(c => `${c.artist.toLowerCase()}::${c.name.toLowerCase()}`));
            const need = MAX_RESULTS - results.length;
            let checked = 0;

            // A single explicitly-named artist (searchMode "artist") is one
            // deliberate, bounded lookup — check its FULL Deezer top
            // catalog (up to 50, not the default 15) and skip the overall
            // MAX_TRACKS_SEARCHED cap, since there's only ever one artist
            // to exhaust. See replace-candidates-budget/route.ts's own copy
            // of this for the full explanation (confirmed live: a 168 BPM
            // search against Teebee's catalog had its one real match,
            // "Cherokee", at position #39 — past both the old top=15 limit
            // and the checked>=30 point the budget route used to give up
            // at).
            const singleArtistMode = body.searchMode === "artist" && artistNames.length === 1;
            const topLimit = singleArtistMode ? 50 : 15;
            const tracksCap = singleArtistMode ? Infinity : MAX_TRACKS_SEARCHED;

            console.log(`[replace-candidates] online top-up: artists=${JSON.stringify(artistNames)} need=${need} targetBpm=${targetBpm}`);
            let rejectedNoIsrc = 0, rejectedNoBpm = 0, rejectedExisting = 0, rejectedExcluded = 0, rejectedDuration = 0, rejectedBpm = 0, rejectedEnergy = 0, accepted = 0;

            outer:
            for (const artistName of artistNames) {
              if (results.length - libraryCandidates.length >= need) break;
              const artistResult = await deezerArtistTopTracks(artistName, true, topLimit);
              if (!artistResult.ok) {
                console.log(`[replace-candidates] Deezer lookup failed for "${artistName}": ${artistResult.error}`);
              }
              const withIsrc = artistResult.ok
                ? artistResult.tracks.filter((t): t is typeof t & { isrc: string } => !!t.isrc)
                : [];
              if (artistResult.ok) {
                rejectedNoIsrc += artistResult.tracks.length - withIsrc.length;
                console.log(`[replace-candidates] "${artistName}": Deezer returned ${artistResult.tracks.length} tracks, ${withIsrc.length} with an ISRC`);
              }

              // Resolve BPM one at a time (ReccoBeats via ISRC) and keep
              // only ones that actually land near the target — stop once
              // enough are found or the candidate pool from Deezer runs
              // out, rather than resolving every single one regardless of
              // how many are already accepted. Progress is per-artist
              // (current/total reset for each artistNames entry) — the
              // grand total across every artist isn't known up front
              // without an extra round-trip per artist just to measure it.
              let checkedForArtist = 0;
              for (const t of withIsrc) {
                if (results.length - libraryCandidates.length >= need) break outer;
                if (checked >= tracksCap) break outer;
                // Genre search spreads across up to MAX_ARTISTS_SEARCHED
                // artists that were never explicitly requested (unlike the
                // "search by artist" override, which is one artist the user
                // specifically typed) — capping how many of any one
                // artist's tracks get resolved keeps the search moving
                // across artists instead of burning the whole budget deep
                // into one artist's catalog.
                if (body.searchMode === "genre" && checkedForArtist >= MAX_TRACKS_PER_ARTIST_IN_GENRE_MODE) break;
                const key = `${t.artist.toLowerCase()}::${t.title.toLowerCase()}`;
                if (seenKeys.has(key)) continue;
                seenKeys.add(key);
                if (checked > 0) await sleep(120);
                checked++;
                checkedForArtist++;
                // total is how many candidates there are TO CHECK for this
                // artist, not how many acceptances we're trying to reach —
                // "need" is a stopping threshold on ACCEPTED matches, a
                // different count entirely.
                send({ type: "progress", current: checkedForArtist, total: withIsrc.length, name: t.title, artist: t.artist, hits: accepted });
                try {
                  const resolved = await resolveByIsrc(t.isrc);
                  if (!resolved) { rejectedNoBpm++; continue; }
                  if (existingUris.has(resolved.uri)) { rejectedExisting++; continue; } // already covered by the library search above
                  if (excludeUris.has(resolved.uri)) { rejectedExcluded++; continue; } // already in the mix — would land as a duplicate
                  if (!durationOk(t.durationMs)) { rejectedDuration++; continue; }
                  if (!isExactBpm(resolved.tempo, targetBpm)) { rejectedBpm++; continue; }
                  if (body.energyBand && (resolved.energy == null || !energyInBand(resolved.energy, body.energyBand))) { rejectedEnergy++; continue; }
                  accepted++;
                  results.push({
                    source: "online",
                    uri: resolved.uri,
                    name: t.title,
                    artist: t.artist,
                    tempo: resolved.tempo,
                    effectiveBpm: effectiveTempo(resolved.tempo),
                    durationMs: t.durationMs,
                    isrc: t.isrc,
                    key: resolved.key,
                    mode: resolved.mode,
                    energy: resolved.energy,
                    danceability: resolved.danceability,
                    valence: resolved.valence,
                    genres: null,
                  });
                } catch { /* best-effort — one failed resolution shouldn't abort the rest */ }
              }
            }
            console.log(`[replace-candidates] online top-up done: checked=${checked} accepted=${accepted} rejected{noIsrc=${rejectedNoIsrc}, noBpmData=${rejectedNoBpm}, alreadyInLibrary=${rejectedExisting}, alreadyInMix=${rejectedExcluded}, durationMismatch=${rejectedDuration}, bpmMismatch=${rejectedBpm}, energyMismatch=${rejectedEnergy}}`);
          } catch (err) {
            console.log(`[replace-candidates] online top-up threw: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Presentation order: every candidate here already passed the BPM
        // tolerance gate above (that's what decided who's in the pool at
        // all) — within that already-qualified set, rank by closeness to
        // the original track's own length, per the user's explicit
        // request. Falls back to BPM closeness only when there's no
        // original length to rank by (durationOk lets everything through
        // in that case).
        results.sort((a, b) => {
          if (originalDurationMs != null && a.durationMs != null && b.durationMs != null) {
            return Math.abs(a.durationMs - originalDurationMs) - Math.abs(b.durationMs - originalDurationMs);
          }
          return bpmDistance(a.tempo, targetBpm) - bpmDistance(b.tempo, targetBpm);
        });
        send({ type: "done", candidates: results.slice(0, MAX_RESULTS) });
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : "Search failed" });
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Content-Encoding": "none",
    },
  });
}
