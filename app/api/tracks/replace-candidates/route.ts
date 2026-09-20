import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readAllTracks } from "@/lib/tracks-store";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { resolveByIsrc, sleep } from "@/lib/track-enrich";
import { deezerArtistTopTracks } from "@/lib/deezer-artist-top";

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
}

// SSE: streams {"type":"progress","current","total","name"} for each online
// candidate resolved (the library scan itself is instant), then
// {"type":"done","candidates"} or {"type":"error"} — same shape as
// replace-candidates-budget/route.ts's own stream.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { targetBpm?: number; artistName?: string; excludeUris?: string[]; originalDurationMs?: number };
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

        // ── Library search ──────────────────────────────────────────
        const rows = readAllTracks(loadRunningPlaylistConfig().csvFile)
          .filter(t => t.uri && !excludeUris.has(t.uri) && t.tempo != null && t.durationMs != null && durationOk(t.durationMs));

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
            _dist: bpmDistance(t.tempo!, targetBpm),
          }))
          .filter(t => isExactBpm(t.tempo, targetBpm))
          .sort((a, b) => a._dist - b._dist)
          .slice(0, MAX_RESULTS)
          .map(({ _dist, ...c }) => c);

        const results: ReplaceCandidate[] = [...libraryCandidates];

        // ── Online top-up (own + related artists, Deezer) ────────────
        // Only when the library alone didn't fill the list, and only when
        // we know which artist to search from (the track being replaced).
        if (results.length < MAX_RESULTS && body.artistName) {
          send({ type: "online-start" });
          try {
            const artistResult = await deezerArtistTopTracks(body.artistName, true);
            const withIsrc = artistResult.ok
              ? artistResult.tracks.filter((t): t is typeof t & { isrc: string } => !!t.isrc)
              : [];

            const existingUris = new Set(rows.map(t => t.uri));
            const seenKeys = new Set(libraryCandidates.map(c => `${c.artist.toLowerCase()}::${c.name.toLowerCase()}`));
            const need = MAX_RESULTS - results.length;
            let checked = 0;

            // Resolve BPM one at a time (ReccoBeats via ISRC) and keep only
            // ones that actually land near the target — stop once enough
            // are found or the candidate pool from Deezer runs out, rather
            // than resolving every single one regardless of how many are
            // already accepted.
            for (const t of withIsrc) {
              if (results.length - libraryCandidates.length >= need) break;
              const key = `${t.artist.toLowerCase()}::${t.title.toLowerCase()}`;
              if (seenKeys.has(key)) continue;
              seenKeys.add(key);
              if (checked > 0) await sleep(120);
              checked++;
              send({ type: "progress", current: checked, total: need, name: t.title, artist: t.artist });
              try {
                const resolved = await resolveByIsrc(t.isrc);
                if (!resolved) continue;
                if (existingUris.has(resolved.uri)) continue; // already covered by the library search above
                if (excludeUris.has(resolved.uri)) continue; // already in the mix — would land as a duplicate
                if (!durationOk(t.durationMs)) continue;
                if (!isExactBpm(resolved.tempo, targetBpm)) continue;
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
                });
              } catch { /* best-effort — one failed resolution shouldn't abort the rest */ }
            }
          } catch { /* best-effort — online top-up is a supplement, library results still return */ }
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
