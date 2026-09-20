import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readAllTracks } from "@/lib/tracks-store";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { resolveByIsrc, sleep } from "@/lib/track-enrich";
import { deezerArtistTopTracks } from "@/lib/deezer-artist-top";
import { artistsSharingGenre, parseGenres } from "@/lib/genre-artists";

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
const MAX_ONLINE_RESOLVE = 30;
// Hard cap on how many DIFFERENT artists' Deezer catalogs get searched —
// each is its own sequential fetch, on top of every candidate's own
// ReccoBeats resolution, so this stays small regardless of how many
// candidate artists the (own-artists + genre-sharing) selection turns up.
const MAX_ARTISTS_SEARCHED = 5;

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
        const rows = allRows
          .filter(t => t.uri && !excludeUris.has(t.uri) && t.tempo != null && t.durationMs != null && isExactBpm(t.tempo, targetBpm));

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
            const seedGenres = new Set([body.searchValue.trim().toLowerCase()]);
            artistNames = artistsSharingGenre(allRows, seedGenres, [], MAX_ARTISTS_SEARCHED);
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

        if (artistNames.length > 0) {
          send({ type: "online-start" });
          const existingUris = new Set(rows.map(t => t.uri));
          const seenKeys = new Set(pool.map(c => `${c.artist.toLowerCase()}::${c.name.toLowerCase()}`));
          let resolved = 0;

          const budgetSec = budgetMs / 1000;
          const poolCoversBudget = () => pool.reduce((sum, t) => sum + t.durationMs / 1000, 0) >= budgetSec;

          outer:
          for (const artistName of artistNames) {
            if (resolved >= MAX_ONLINE_RESOLVE || poolCoversBudget()) break;
            try {
              const artistResult = await deezerArtistTopTracks(artistName, true);
              if (!artistResult.ok) continue;
              const withIsrc = artistResult.tracks.filter((t): t is typeof t & { isrc: string } => !!t.isrc);
              for (const t of withIsrc) {
                if (resolved >= MAX_ONLINE_RESOLVE || poolCoversBudget()) break outer;
                const key = `${t.artist.toLowerCase()}::${t.title.toLowerCase()}`;
                if (seenKeys.has(key)) continue;
                seenKeys.add(key);
                if (resolved > 0) await sleep(120);
                resolved++;
                send({ type: "progress", current: resolved, total: MAX_ONLINE_RESOLVE, name: t.title, artist: t.artist });
                try {
                  const r = await resolveByIsrc(t.isrc);
                  if (!r) continue;
                  if (existingUris.has(r.uri) || excludeUris.has(r.uri)) continue;
                  if (!isExactBpm(r.tempo, targetBpm)) continue;
                  pool.push({
                    source: "online", uri: r.uri, name: t.title, artist: t.artist,
                    tempo: r.tempo, effectiveBpm: r.tempo, durationMs: t.durationMs ?? 0,
                    isrc: t.isrc, key: r.key, mode: r.mode, energy: r.energy, danceability: r.danceability, valence: r.valence,
                  });
                } catch { /* best-effort — one failed resolution shouldn't abort the rest */ }
              }
            } catch { /* best-effort — one artist's lookup failing shouldn't abort the others */ }
          }
        }

        const usable = pool.filter(t => t.durationMs > 0);
        const chosen = fitBudget(usable, budgetMs / 1000);
        const totalMs = chosen.reduce((sum, t) => sum + t.durationMs, 0);
        send({ type: "done", tracks: chosen, totalMs, budgetMs, poolSize: usable.length });
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
