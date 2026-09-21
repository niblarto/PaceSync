import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readAllTracks } from "@/lib/tracks-store";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { deezerIsrc, resolveByIsrc, sleep, UA } from "@/lib/track-enrich";

// Dashboard chart's multi-select "🔍 Lookup tracks…" menu item — takes a
// pasted plain-text list of tracks (one per line, "Title" — Artist or
// Title - Artist), resolves each to a real Spotify track + BPM via the same
// Deezer-ISRC-then-ReccoBeats pipeline used everywhere else in this app
// (lib/track-enrich.ts), and flags whether it's already in the active
// library. Read-only lookup for now — results aren't written into the mix
// (that's a follow-up; this just answers "what BPM is this, and can I
// preview it" for a list the user typed/pasted from elsewhere, e.g. a
// setlist or another DJ's tracklist).

const MAX_LINES = 60; // sequential Deezer+ReccoBeats round-trips per line — keep a pasted list bounded

interface ParsedLine {
  raw: string;
  title: string | null;
  artist: string | null;
}

// Accepts "Title" — Artist, "Title" - Artist, Title — Artist, Title - Artist
// (em dash, en dash or hyphen, with or without quotes around the title).
// Multiple artists after "ft."/"feat."/"&" are kept as one string — Deezer's
// search handles a combined artist string fine, and splitting it isn't
// needed for the ISRC lookup this route does.
function parseLine(raw: string): ParsedLine {
  const trimmed = raw.trim();
  if (!trimmed) return { raw, title: null, artist: null };
  const m = trimmed.match(/^[""]?(.+?)[""]?\s*[—–-]\s*(.+)$/);
  if (!m) return { raw, title: trimmed, artist: null };
  const title = m[1].trim().replace(/^["']|["']$/g, "");
  const artist = m[2].trim();
  return { raw, title: title || null, artist: artist || null };
}

export interface LookupResult {
  raw: string;
  title: string | null;
  artist: string | null;
  matched: boolean;
  uri: string | null;
  name: string | null;
  matchedArtist: string | null;
  tempo: number | null;
  durationMs: number | null;
  inLibrary: boolean;
  error: string | null;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { text } = await req.json() as { text?: string };
  if (!text?.trim()) return NextResponse.json({ error: "text required" }, { status: 400 });

  const lines = text.split("\n").map(l => l.trim()).filter(Boolean).slice(0, MAX_LINES);
  if (lines.length === 0) return NextResponse.json({ error: "No lines to look up" }, { status: 400 });

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
        // Match "already in library" by track name + primary artist
        // (case-insensitive) rather than URI — the whole point of this
        // route is resolving tracks that may not have a URI on hand yet.
        const libraryKeys = new Set(
          allRows.map(t => `${(t.trackName ?? "").trim().toLowerCase()}::${(t.artistNames ?? "").split(",")[0]?.trim().toLowerCase()}`),
        );

        const results: LookupResult[] = [];
        for (let i = 0; i < lines.length; i++) {
          const parsed = parseLine(lines[i]);
          send({ type: "progress", current: i + 1, total: lines.length, name: parsed.title ?? parsed.raw, artist: parsed.artist });

          if (!parsed.title || !parsed.artist) {
            results.push({ ...parsed, matched: false, uri: null, name: null, matchedArtist: null, tempo: null, durationMs: null, inLibrary: false, error: "Couldn't parse title/artist from this line" });
            continue;
          }

          if (i > 0) await sleep(150);
          try {
            const isrc = await deezerIsrc(parsed.title, parsed.artist);
            if (!isrc) {
              results.push({ ...parsed, matched: false, uri: null, name: null, matchedArtist: null, tempo: null, durationMs: null, inLibrary: false, error: "No Deezer match found" });
              continue;
            }
            await sleep(150);
            const resolved = await resolveByIsrc(isrc);
            if (!resolved) {
              results.push({ ...parsed, matched: false, uri: null, name: null, matchedArtist: null, tempo: null, durationMs: null, inLibrary: false, error: "Found on Deezer but ReccoBeats has no BPM data for it" });
              continue;
            }
            // Deezer's own track record has the confirmed title/artist and
            // duration — fetch it once more for display purposes (the ISRC
            // lookup above only returns the id). GET /track/isrc:{isrc} is
            // Deezer's direct-lookup-by-ISRC endpoint; the search-based
            // form (q=isrc:"...") that used to be here always returned zero
            // results (confirmed live), silently leaving durationMs null
            // for every matched track and breaking the "try and add to
            // mix" budget-fit downstream (which requires a real duration).
            let matchedName = parsed.title;
            let matchedArtist = parsed.artist;
            let durationMs: number | null = null;
            try {
              const dr = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
              if (dr.ok) {
                const hit = await dr.json() as { title?: string; artist?: { name?: string }; duration?: number };
                if (hit?.title) matchedName = hit.title;
                if (hit?.artist?.name) matchedArtist = hit.artist.name;
                if (typeof hit?.duration === "number") durationMs = hit.duration * 1000;
              }
            } catch { /* best-effort — the core BPM/URI result above still stands without this */ }

            const inLibrary = libraryKeys.has(`${matchedName.trim().toLowerCase()}::${matchedArtist.trim().toLowerCase()}`);

            results.push({
              ...parsed, matched: true, uri: resolved.uri, name: matchedName, matchedArtist,
              tempo: resolved.tempo, durationMs, inLibrary, error: null,
            });
          } catch (err) {
            results.push({ ...parsed, matched: false, uri: null, name: null, matchedArtist: null, tempo: null, durationMs: null, inLibrary: false, error: err instanceof Error ? err.message : "Lookup failed" });
          }
        }

        send({ type: "done", results });
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : "Lookup failed" });
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Content-Encoding": "none",
      "Connection": "keep-alive",
    },
  });
}
