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

// Multi-track "remix selected" (Dashboard chart's multi-select ♻ menu):
// discards every selected track and refills their COMBINED time budget with
// as many or as few exact-BPM tracks as fit closest, instead of swapping
// each selected slot 1-for-1 (which frequently fails — a single slot's own
// ±15s duration tolerance is far more restrictive than "the whole stretch
// sums close"). Mirrors ai_dj/workout.py's _fit_duration_precise (the same
// segment-fill combination search the Python mixer itself uses), just
// searching an exact-BPM candidate pool here instead of the mixer's
// LLM-ranked one.
//
// BPM match is exact and LITERAL — a candidate's own raw tempo must round to
// targetBpm, unlike replace-candidates/route.ts's single-track swap (which
// also accepts a half/double-time match, since that route always shows the
// "×2" badge next to a doubled pick). No half/double-time acceptance here:
// TrackWithBPM.bpm is populated everywhere in this app from a track's RAW
// tempo, never its effective/doubled value, so a half-time track accepted
// here would apply showing a completely different number than what was
// typed (confirmed: an ~86.5 BPM track's raw tempo rounds to 86/87, even
// though doubled it hits a 173 target) — literal-only guarantees the
// track actually applied always displays the exact BPM asked for.
//
// There is NO per-candidate duration filter here (unlike replace-
// candidates/route.ts): any exact-BPM track is valid pool material, since
// it's the SUM that has to land near budgetMs, not any one track's own
// length.

const SHORT_BUDGET_SEC = 180; // <=3min budget: pick the single closest track, don't search sums
const DROP_ATTEMPTS = 8;
const SWAP_LOOKAHEAD = 8;
// Each online candidate costs a real, sequential ReccoBeats round-trip (not
// just the 120ms politeness sleep between them) — resolving a large batch
// of these is the actual source of a slow remix, so this only ever runs
// when the library pool genuinely can't cover the budget on its own (same
// "library first, online only if short" rule replace-candidates/route.ts
// already uses for the single-track swap), and stays capped modestly even
// then rather than exhausting every related-artist track Deezer offers.
//
// EXCEPTION: an explicit single-artist override (searchMode "artist") skips
// this cap and checks that artist's FULL catalog — this is one deliberate,
// bounded lookup against a specific artist the user named, not an
// open-ended scan across several automatically-picked artists (confirmed:
// a 168 BPM search against Teebee's catalog had its one genuine match,
// "Cherokee", sitting at position #39 — past where the old 30-track cap
// gave up). The cap still applies per-artist whenever MORE than one artist
// is being searched (genre mode, or the automatic own-artist +
// genre-sharing default), where unbounded-per-artist would make a
// multi-artist search open-ended again.
const MAX_ONLINE_RESOLVE = 30;
// See replace-candidates/route.ts's own copy of this constant — genre
// search's artists are picked automatically, so cap how many of any one
// artist's tracks get resolved before moving to the next artist.
const MAX_TRACKS_PER_ARTIST_IN_GENRE_MODE = 5;
// Hard cap on how many DIFFERENT artists' Deezer catalogs get searched —
// each is its own sequential fetch, on top of every candidate's own
// ReccoBeats resolution, so this stays bounded regardless of how many
// candidate artists the (own-artists + genre-sharing) selection turns up.
const MAX_ARTISTS_SEARCHED = 10;

function bpmDistance(tempo: number, targetBpm: number): number {
  return Math.abs(tempo - targetBpm);
}
function isExactBpm(tempo: number, targetBpm: number): boolean {
  return Math.round(tempo) === Math.round(targetBpm);
}

export interface BudgetFillTrack {
  source: "library" | "online";
  uri: string | null;
  name: string;
  artist: string;
  tempo: number;
  effectiveBpm: number;
  durationMs: number;
  isrc: string | null;
  key: number | null;
  mode: number | null;
  energy: number | null;
  danceability: number | null;
  valence: number | null;
}

// Ports ai_dj/workout.py's _fit_duration_precise: a bounded combination
// search over an already-ranked pool for whichever subset lands closest to
// budgetSec, rather than accepting the first greedy pass. Pool order here
// is "library first (BPM-closeness order carried over from the DB query),
// then online" — there's no per-track preference ranking to preserve
// beyond that grouping, unlike the mixer's LLM-ordered pool.
function fitBudget<T extends { durationMs: number }>(pool: T[], budgetSec: number): T[] {
  if (pool.length === 0) return [];
  if (budgetSec <= SHORT_BUDGET_SEC) {
    let best = pool[0], bestMiss = Math.abs(pool[0].durationMs / 1000 - budgetSec);
    for (const t of pool) {
      const miss = Math.abs(t.durationMs / 1000 - budgetSec);
      if (miss < bestMiss) { best = t; bestMiss = miss; }
    }
    return [best];
  }

  const durations = pool.map(t => t.durationMs / 1000);
  const n = pool.length;
  const total = (positions: number[]) => positions.reduce((sum, p) => sum + durations[p], 0);

  const greedy: number[] = [];
  let cum = 0;
  let crossingPos: number | null = null;
  for (let pos = 0; pos < n; pos++) {
    const dur = durations[pos];
    if (cum + dur >= budgetSec) {
      crossingPos = pos;
      if (greedy.length === 0 || (cum + dur - budgetSec) < (budgetSec - cum)) greedy.push(pos);
      break;
    }
    greedy.push(pos);
    cum += dur;
  }

  const candidates: number[][] = [greedy];

  if (crossingPos !== null) {
    const base = greedy.filter(p => p !== crossingPos);
    for (let look = crossingPos + 1; look < Math.min(crossingPos + 1 + SWAP_LOOKAHEAD, n); look++) {
      candidates.push([...base, look]);
    }
  }

  const pickedSet = new Set(greedy);
  const unpicked = Array.from({ length: n }, (_, i) => i).filter(p => !pickedSet.has(p));
  for (const dropPos of greedy.slice(-DROP_ATTEMPTS).reverse()) {
    const reduced = greedy.filter(p => p !== dropPos);
    const reducedTotal = total(reduced);
    if (reducedTotal >= budgetSec) { candidates.push(reduced); continue; }
    for (const fillPos of unpicked.slice(0, SWAP_LOOKAHEAD)) {
      if (reduced.includes(fillPos)) continue;
      candidates.push([...reduced, fillPos]);
    }
  }

  const miss = (positions: number[]) => Math.abs(total(positions) - budgetSec);
  const best = candidates.reduce((a, b) => (miss(b) < miss(a) ? b : a));
  return best.slice().sort((a, b) => a - b).map(p => pool[p]);
}

// SSE: streams {"type":"progress","current","total","name"} for each online
// candidate resolved (the library scan itself is instant — no progress
// needed there), then {"type":"done","tracks","totalMs","budgetMs",
// "poolSize"} or {"type":"error"}. Only the online top-up is ever slow
// enough to need this — a plain JSON response left the UI with no signal
// during a multi-candidate ReccoBeats resolution.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as {
    targetBpm?: number; artistNames?: string[]; seedUris?: string[]; excludeUris?: string[]; budgetMs?: number;
    /** Explicit override from the picker's "search by artist/genre" control
        — see replace-candidates/route.ts's own body type for the full
        explanation, mirrored here. */
    searchMode?: "artist" | "genre"; searchValue?: string;
    /** Picker's "force online lookup" toggle — skips the library pool
        entirely for an explicit artist/genre override, so results always
        come fresh from Deezer instead of the same library rows the library
        pool would otherwise keep resurfacing. No effect without
        searchMode/searchValue also set — "force online" only makes sense
        alongside an explicit artist/genre choice. */
    forceOnline?: boolean;
    /** Optional Low/Medium/High energy filter, on top of the exact-BPM
        match — see lib/energy-bands.ts for the band ranges. Applies to
        both the library pool and every online candidate, same as BPM. */
    energyBand?: EnergyBand;
  };
  const targetBpm = body.targetBpm;
  const budgetMs = body.budgetMs;
  if (!targetBpm || targetBpm <= 0) return NextResponse.json({ error: "targetBpm required" }, { status: 400 });
  if (!budgetMs || budgetMs <= 0) return NextResponse.json({ error: "budgetMs required" }, { status: 400 });
  const excludeUris = new Set(body.excludeUris ?? []);

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
        // Padding comment flushes past browsers' 1 KB SSE buffer
        controller.enqueue(encoder.encode(`: ${"x".repeat(1024)}\n\n`));

        const allRows = readAllTracks(loadRunningPlaylistConfig().csvFile);

        // ── Library pool (exact BPM, no duration filter) ──
        // An explicit "search by artist/genre" override must actually
        // constrain which tracks are eligible, not just which artists get
        // searched ONLINE — otherwise any exact-BPM track already in the
        // library, regardless of artist/genre, can fill the whole budget
        // before online search ever runs (confirmed: a 168 BPM Rap/Hip Hop
        // track filled a "Drum and Bass" remix's budget this way, and
        // separately an explicit "Sub Focus" artist override still pulled
        // from the WHOLE library pool since only online search respected
        // it — the library pool alone already covered the budget every
        // time, so online never ran). Genre match is substring-based
        // against the row's own comma-separated Genres tag
        // (case-insensitive) — deliberately looser than an exact tag match,
        // since a track's Genres column can carry several related tags at
        // once and the user's typed genre won't always be phrased exactly
        // like the stored tag. Artist match is against the row's primary
        // artist (first name in the comma-separated Artist Name(s) field),
        // also case-insensitive substring, same convention as
        // lib/genre-artists.ts.
        //
        // forceOnline (the picker's "force online lookup" toggle) skips the
        // library pool for this override entirely — Sub Focus's own
        // library tracks might legitimately already be in the mix
        // (excludeUris) or exhausted, and a user reaching for "force
        // online" wants FRESH candidates from Deezer, not the same already-
        // seen library rows resurfacing.
        const genreFilter = body.searchMode === "genre" && body.searchValue
          ? body.searchValue.trim().toLowerCase()
          : null;
        const artistFilter = body.searchMode === "artist" && body.searchValue
          ? body.searchValue.trim().toLowerCase()
          : null;
        const rows = body.forceOnline
          ? []
          : allRows
            .filter(t => t.uri && !excludeUris.has(t.uri) && t.tempo != null && t.durationMs != null && isExactBpm(t.tempo, targetBpm))
            .filter(t => !genreFilter || (t.genres ?? "").toLowerCase().includes(genreFilter))
            .filter(t => !artistFilter || (t.artistNames ?? "").toLowerCase().includes(artistFilter))
            .filter(t => !body.energyBand || (t.energy != null && energyInBand(t.energy, body.energyBand)));

        const pool: BudgetFillTrack[] = rows
          .map(t => ({
            source: "library" as const,
            uri: t.uri, name: t.trackName ?? "", artist: t.artistNames ?? "",
            tempo: t.tempo!, effectiveBpm: t.tempo!, durationMs: t.durationMs!,
            isrc: t.isrc, key: t.key, mode: t.mode, energy: t.energy, danceability: t.danceability, valence: t.valence,
            _dist: bpmDistance(t.tempo!, targetBpm),
          }))
          .sort((a, b) => a._dist - b._dist)
          .map(({ _dist, ...c }) => c);

        // ── Online top-up (Deezer) ────────────────────────────────────
        // Only when the library pool alone can't plausibly cover the
        // budget — resolving even a handful of online candidates costs
        // real, sequential network round-trips, so this is skipped
        // entirely (the common case, once matching went literal-tempo-only
        // the library still clusters plenty of material around any popular
        // BPM) whenever the library already sums past budgetMs on its own.
        // Which artists get searched (capped at MAX_ARTISTS_SEARCHED):
        //  - Explicit "search by artist" override: just that one artist.
        //  - Explicit "search by genre" override: every library artist
        //    tagged with that exact genre.
        //  - No override (the original automatic behavior): one artist per
        //    originally-selected track, then other library artists sharing
        //    at least one of those tracks' genre tags, up to the cap.
        const libraryTotalSec = pool.reduce((sum, t) => sum + t.durationMs / 1000, 0);
        let artistNames: string[] = [];
        if (libraryTotalSec < budgetMs / 1000) {
          if (body.searchMode === "artist" && body.searchValue) {
            artistNames = [body.searchValue];
          } else if (body.searchMode === "genre" && body.searchValue) {
            // Discogs first (real genre/style-tagged release data), falls
            // back to the library-only heuristic — see replace-candidates/
            // route.ts's own copy of this branch for the full explanation.
            artistNames = await discogsArtistsForGenre(body.searchValue, MAX_ARTISTS_SEARCHED);
            if (artistNames.length === 0) {
              const seedGenres = new Set([body.searchValue.trim().toLowerCase()]);
              artistNames = artistsSharingGenre(allRows, seedGenres, [], MAX_ARTISTS_SEARCHED);
            }
          } else {
            const ownArtists = Array.from(new Set((body.artistNames ?? []).filter(Boolean).map(a => a.trim().toLowerCase())))
              .map(lower => (body.artistNames ?? []).find(a => a.trim().toLowerCase() === lower)!);
            const seedGenres = new Set<string>();
            for (const uri of body.seedUris ?? []) {
              const row = allRows.find(t => t.uri === uri);
              for (const g of Array.from(parseGenres(row?.genres ?? null))) seedGenres.add(g);
            }
            const genreArtists = ownArtists.length > 0
              ? artistsSharingGenre(allRows, seedGenres, ownArtists, Math.max(0, MAX_ARTISTS_SEARCHED - ownArtists.length))
              : [];
            artistNames = [...ownArtists, ...genreArtists.filter(a => !ownArtists.some(o => o.toLowerCase() === a.toLowerCase()))];
          }
          artistNames = artistNames.slice(0, MAX_ARTISTS_SEARCHED);
        }

        console.log(`[replace-candidates-budget] searchMode=${body.searchMode ?? "auto"} searchValue=${body.searchValue ?? "(none)"} forceOnline=${!!body.forceOnline} energyBand=${body.energyBand ?? "(any)"} libraryPoolSize=${pool.length} libraryTotalSec=${libraryTotalSec.toFixed(1)} budgetSec=${(budgetMs / 1000).toFixed(1)} artistNames=${JSON.stringify(artistNames)}`);

        // A single explicitly-named artist (searchMode "artist") is one
        // deliberate, bounded lookup — check that artist's FULL Deezer top
        // catalog (up to 50 tracks, not the default 15) and don't give up
        // at MAX_ONLINE_RESOLVE either, since there's only ever one artist
        // to exhaust. Genre mode / automatic mode still use the smaller
        // per-artist default and the overall cap, since those can involve
        // several artists and staying bounded matters more there.
        const singleArtistMode = body.searchMode === "artist" && artistNames.length === 1;
        const topLimit = singleArtistMode ? 50 : 15;
        const resolveCap = singleArtistMode ? Infinity : MAX_ONLINE_RESOLVE;

        if (artistNames.length > 0) {
          send({ type: "online-start" });
          const existingUris = new Set(rows.map(t => t.uri));
          const seenKeys = new Set(pool.map(c => `${c.artist.toLowerCase()}::${c.name.toLowerCase()}`));
          let resolved = 0;
          let rejectedNoBpm = 0, rejectedExisting = 0, rejectedExcluded = 0, rejectedBpm = 0, rejectedEnergy = 0, accepted = 0;

          const budgetSec = budgetMs / 1000;
          const poolCoversBudget = () => pool.reduce((sum, t) => sum + t.durationMs / 1000, 0) >= budgetSec;

          outer:
          for (const artistName of artistNames) {
            if (resolved >= resolveCap || poolCoversBudget()) break;
            try {
              const artistResult = await deezerArtistTopTracks(artistName, true, topLimit);
              if (!artistResult.ok) {
                console.log(`[replace-candidates-budget] Deezer lookup failed for "${artistName}": ${artistResult.error}`);
                continue;
              }
              const withIsrc = artistResult.tracks.filter((t): t is typeof t & { isrc: string } => !!t.isrc);
              console.log(`[replace-candidates-budget] "${artistName}": Deezer returned ${artistResult.tracks.length} tracks, ${withIsrc.length} with an ISRC`);
              let resolvedForArtist = 0;
              for (const t of withIsrc) {
                if (resolved >= resolveCap || poolCoversBudget()) break outer;
                // See replace-candidates/route.ts's own copy of this cap
                // for the full explanation — genre search's artists aren't
                // user-chosen, so spread the budget across artists instead
                // of exhausting one before trying the next.
                if (body.searchMode === "genre" && resolvedForArtist >= MAX_TRACKS_PER_ARTIST_IN_GENRE_MODE) break;
                const key = `${t.artist.toLowerCase()}::${t.title.toLowerCase()}`;
                if (seenKeys.has(key)) continue;
                seenKeys.add(key);
                if (resolved > 0) await sleep(120);
                resolved++;
                resolvedForArtist++;
                // hits: a running count of ACCEPTED matches so far, shown
                // alongside the checked/total progress — lets the user see
                // "found 1 so far" while a long single-artist search is
                // still working through the rest of the catalog.
                send({ type: "progress", current: resolved, total: Number.isFinite(resolveCap) ? resolveCap : withIsrc.length, name: t.title, artist: t.artist, hits: accepted });
                try {
                  const r = await resolveByIsrc(t.isrc);
                  if (!r) { rejectedNoBpm++; continue; }
                  if (existingUris.has(r.uri)) { rejectedExisting++; continue; }
                  if (excludeUris.has(r.uri)) { rejectedExcluded++; continue; }
                  if (!isExactBpm(r.tempo, targetBpm)) { rejectedBpm++; continue; }
                  if (body.energyBand && (r.energy == null || !energyInBand(r.energy, body.energyBand))) { rejectedEnergy++; continue; }
                  accepted++;
                  pool.push({
                    source: "online", uri: r.uri, name: t.title, artist: t.artist,
                    tempo: r.tempo, effectiveBpm: r.tempo, durationMs: t.durationMs ?? 0,
                    isrc: t.isrc, key: r.key, mode: r.mode, energy: r.energy, danceability: r.danceability, valence: r.valence,
                  });
                } catch { /* best-effort — one failed resolution shouldn't abort the rest */ }
              }
            } catch { /* best-effort — one artist's lookup failing shouldn't abort the others */ }
          }
          console.log(`[replace-candidates-budget] online top-up done: checked=${resolved} accepted=${accepted} rejected{noBpmData=${rejectedNoBpm}, alreadyInLibrary=${rejectedExisting}, alreadyInMix=${rejectedExcluded}, bpmMismatch=${rejectedBpm}, energyMismatch=${rejectedEnergy}}`);
        }

        // An explicit artist/genre override constrains the pool to that
        // artist/genre — but that artist might genuinely only have a
        // handful of tracks at the exact target BPM (confirmed live: a
        // Teebee 168 BPM search found exactly 1 real match, "Cherokee",
        // against a ~25min combined budget from 6 selected tracks — using
        // just that one match left the mix ~18min shorter than before).
        // Rather than silently apply a big underfill, backfill the
        // remaining shortfall from the WHOLE library (any artist/genre,
        // still exact-BPM, but NOT energy-filtered — the backfill is a
        // last-resort length-preservation measure, and stacking the energy
        // constraint on top would only make the underfill worse) so the
        // mix's actual length is preserved, and tell the user how many of
        // the final tracks came from that fallback so they know the result
        // isn't purely Teebee/"Drum and Bass"/whatever they asked for.
        const usable = pool.filter(t => t.durationMs > 0);
        const constrainedSec = usable.reduce((sum, t) => sum + t.durationMs / 1000, 0);
        const budgetSec = budgetMs / 1000;
        const hasConstraint = ((body.searchMode === "artist" || body.searchMode === "genre") && !!body.searchValue) || !!body.energyBand;
        let backfillCount = 0;
        if (hasConstraint && constrainedSec < budgetSec * 0.5) {
          const usedUris = new Set(usable.map(t => t.uri).filter((u): u is string => !!u));
          const fallbackRows = allRows
            .filter(t => t.uri && !usedUris.has(t.uri) && !excludeUris.has(t.uri) && t.tempo != null && t.durationMs != null && isExactBpm(t.tempo, targetBpm));
          const fallbackPool: BudgetFillTrack[] = fallbackRows
            .map(t => ({
              source: "library" as const,
              uri: t.uri, name: t.trackName ?? "", artist: t.artistNames ?? "",
              tempo: t.tempo!, effectiveBpm: t.tempo!, durationMs: t.durationMs!,
              isrc: t.isrc, key: t.key, mode: t.mode, energy: t.energy, danceability: t.danceability, valence: t.valence,
              _dist: bpmDistance(t.tempo!, targetBpm),
            }))
            .sort((a, b) => a._dist - b._dist)
            .map(({ _dist, ...c }) => c);
          backfillCount = fallbackPool.length;
          usable.push(...fallbackPool);
          console.log(`[replace-candidates-budget] constrained pool only covers ${constrainedSec.toFixed(0)}s of ${budgetSec.toFixed(0)}s budget — backfilling with ${fallbackPool.length} unconstrained library tracks`);
        }

        const constraintDesc = [
          body.searchValue ? `"${body.searchValue}"` : null,
          body.energyBand ? `${body.energyBand} energy` : null,
        ].filter(Boolean).join(" + ");
        const fallbackTrackSet = new Set(backfillCount > 0 ? usable.slice(usable.length - backfillCount) : []);
        const chosen = fitBudget(usable, budgetSec);
        const totalMs = chosen.reduce((sum, t) => sum + t.durationMs, 0);
        const chosenFromFallback = chosen.filter(t => fallbackTrackSet.has(t)).length;
        send({
          type: "done", tracks: chosen, totalMs, budgetMs, poolSize: usable.length,
          ...(chosenFromFallback > 0 ? { warning: `Only found enough ${constraintDesc} matches to cover part of the budget — topped up with ${chosenFromFallback} other track${chosenFromFallback === 1 ? "" : "s"} from your library to keep the mix's length.` } : {}),
        });
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
