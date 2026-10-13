import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { readAllTracks } from "@/lib/tracks-store";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { resolveByIsrc } from "@/lib/track-enrich";
import { addTracksToLibrary } from "@/lib/library-add";
import { healActiveCsv } from "@/lib/csv-heal";

// Song Crawler (Settings > Tracklist): starting from a library track's
// artist, walks Deezer "artist radio" breadth-first. Every radio track's BPM
// is checked against the seed track's; matches are resolved to a Spotify
// URI via ISRC (ReccoBeats — never Spotify's Search API, see
// lib/track-enrich.ts resolveByIsrc) and added to the library. Each new
// artist met in a radio is queued and crawled the same way. Streams a log
// as SSE; the client stops the crawl by aborting the request.

const DOUBLETIME_THRESHOLD = 95; // mirrors MixPaceChart / replace-candidates
const BPM_TOLERANCE = 1;
// Once this many distinct artists have been found (seed included), no new
// ones are queued — the crawl finishes the ones already queued, then ends.
const MAX_ARTISTS = 50;
const RADIO_LIMIT = 25;
const DEEZER_GAP_MS = 150; // Deezer allows 50 req/5s; stay well under

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const effective = (bpm: number) => (bpm < DOUBLETIME_THRESHOLD ? bpm * 2 : bpm);

interface DeezerRadioTrack { id: number; title: string; artist: { id: number; name: string } }

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { artist, bpm } = await req.json() as { artist?: string; bpm?: number };
  if (!artist || !bpm || bpm <= 0) return NextResponse.json({ error: "artist and bpm required" }, { status: 400 });
  const target = effective(bpm);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const stopped = () => closed || req.signal.aborted;
      const send = (data: object) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch { closed = true; }
      };
      const log = (msg: string, level: "info" | "match" | "warn" = "info") => send({ type: "log", level, msg });
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: hb\n\n`)); } catch { closed = true; }
      }, 15000);

      let added = 0;
      try {
        controller.enqueue(encoder.encode(`: ${"x".repeat(1024)}\n\n`));

        const library = readAllTracks(loadRunningPlaylistConfig().csvFile);
        const knownUris = new Set(library.map(t => t.uri).filter(Boolean));
        const knownIsrcs = new Set(library.map(t => t.isrc).filter((x): x is string => !!x));

        const deezer = async <T,>(path: string): Promise<T | null> => {
          await sleep(DEEZER_GAP_MS);
          const res = await fetch(`https://api.deezer.com${path}`, { signal: AbortSignal.timeout(15000) });
          if (!res.ok) return null;
          const data = await res.json() as T & { error?: unknown };
          return data.error ? null : data;
        };

        // Seed: exact (case-insensitive) artist-name match, same rule as
        // lib/deezer-artist-top.ts so "Hybrid" never becomes "Hybrid Minds".
        const found = await deezer<{ data?: { id: number; name: string }[] }>(`/search/artist?q=${encodeURIComponent(artist)}&limit=25`);
        const seed = found?.data?.find(a => a.name.trim().toLowerCase() === artist.trim().toLowerCase());
        if (!seed) {
          log(`No exact Deezer artist match for "${artist}"`, "warn");
          send({ type: "done", added });
          return;
        }
        log(`Seed artist: ${seed.name} — looking for ${Math.round(target)} BPM (±${BPM_TOLERANCE}, half/double-time aware)`);

        const queue: { id: number; name: string }[] = [seed];
        const queuedArtists = new Set<number>([seed.id]);
        const seenTracks = new Set<number>();
        let artistsCrawled = 0;

        while (queue.length > 0 && !stopped()) {
          const current = queue.shift()!;
          artistsCrawled++;
          log(`[${artistsCrawled}/${queuedArtists.size}] Artist radio: ${current.name} (${queue.length} still queued)`);

          const radio = await deezer<{ data?: DeezerRadioTrack[] }>(`/artist/${current.id}/radio?limit=${RADIO_LIMIT}`);
          if (!radio?.data?.length) { log(`  no radio for ${current.name}`, "warn"); continue; }

          for (const t of radio.data) {
            if (stopped()) break;
            if (!queuedArtists.has(t.artist.id) && queuedArtists.size < MAX_ARTISTS) {
              queuedArtists.add(t.artist.id);
              if (queuedArtists.size === MAX_ARTISTS) {
                log(`Reached ${MAX_ARTISTS} artists — no more will be added; finishing the ${queue.length + 1} still queued.`, "warn");
              }
              queue.push({ id: t.artist.id, name: t.artist.name });
            }
            if (seenTracks.has(t.id)) continue;
            seenTracks.add(t.id);

            const label = `${t.title} — ${t.artist.name}`;
            const detail = await deezer<{ bpm?: number; isrc?: string }>(`/track/${t.id}`);
            const isrc = detail?.isrc ?? null;
            if (isrc && knownIsrcs.has(isrc)) { log(`  ${label}: already in library`); continue; }

            // Deezer's bpm is 0 when unknown — fall back to ReccoBeats'
            // tempo, which the ISRC lookup returns anyway.
            let tempo = detail?.bpm && detail.bpm > 0 ? detail.bpm : null;
            let resolved: Awaited<ReturnType<typeof resolveByIsrc>> = null;
            if (tempo == null && isrc) {
              resolved = await resolveByIsrc(isrc).catch(() => null);
              tempo = resolved?.tempo ?? null;
            }
            if (tempo == null) { log(`  ${label}: no BPM available`); continue; }

            const matches = Math.abs(effective(tempo) - target) <= BPM_TOLERANCE;
            if (!matches) { log(`  ${label}: ${Math.round(tempo)} BPM`); continue; }

            if (!isrc) { log(`  ${label}: ${Math.round(tempo)} BPM matches, but no ISRC to resolve on Spotify`, "warn"); continue; }
            if (!resolved) resolved = await resolveByIsrc(isrc).catch(() => null);
            if (!resolved) { log(`  ${label}: ${Math.round(tempo)} BPM matches, but couldn't resolve a Spotify track`, "warn"); continue; }
            if (knownUris.has(resolved.uri)) { log(`  ${label}: already in library`); continue; }

            const result = await addTracksToLibrary([{
              uri: resolved.uri, name: t.title, artist: t.artist.name, tempo: resolved.tempo ?? tempo,
              key: resolved.key, mode: resolved.mode, energy: resolved.energy,
              danceability: resolved.danceability, valence: resolved.valence,
            }]);
            knownUris.add(resolved.uri);
            knownIsrcs.add(isrc);
            if (result.added > 0) {
              added++;
              log(`  ✓ ADDED ${label} (${Math.round(tempo)} BPM)`, "match");
              send({ type: "added", uri: resolved.uri, name: t.title, artist: t.artist.name, bpm: tempo });
            } else {
              log(`  ${label}: matches, but was previously deleted from the library — skipped`, "warn");
            }
          }
        }

        if (stopped()) log(`Stopped. ${added} track${added === 1 ? "" : "s"} added.`, "warn");
        else if (queue.length === 0) log(`Crawl complete — no more artists to visit. ${added} track${added === 1 ? "" : "s"} added.`);
        else log(`${added} track${added === 1 ? "" : "s"} added.`);
        send({ type: "done", added });
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : "Song crawl failed" });
      } finally {
        clearInterval(heartbeat);
        // Backfill genres/duration for anything added (not awaited — same
        // reasoning as /api/tracks/add).
        if (added > 0) void healActiveCsv().catch(() => {});
        if (!closed) { try { controller.close(); } catch { /* already closed */ } }
      }
    },
    cancel() { /* client aborted — req.signal.aborted stops the loop */ },
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
