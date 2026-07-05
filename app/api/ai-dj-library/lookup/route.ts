import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import fs from "fs";
import path from "path";

const CACHE_FILE = path.join(process.cwd(), "spotify-cache.json");

type CacheEntry = { uri: string; name: string; artistName: string } | null;

// Shared with /api/bbc/tracks — same disk cache, same cache-key convention
// (title|||artist lowercased), so lookups here reuse prior BBC/library hits.
const spotifyCache = new Map<string, CacheEntry>();

function loadCacheFromDisk() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf-8");
    const obj = JSON.parse(raw) as Record<string, CacheEntry>;
    for (const [k, v] of Object.entries(obj)) {
      spotifyCache.set(k, v);
    }
  } catch { /* file missing or corrupt — start empty */ }
}

function saveCacheToDisk() {
  try {
    const obj: Record<string, CacheEntry> = Object.fromEntries(Array.from(spotifyCache.entries()));
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj), "utf-8");
  } catch (e) {
    console.warn("[ai-dj-library/lookup] Failed to write disk cache:", e);
  }
}

loadCacheFromDisk();

function parseRetryAfter(raw: string): number {
  const delta = parseInt(raw, 10);
  if (!isNaN(delta)) return delta;
  const date = new Date(raw).getTime();
  if (!isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return 30;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// At most 2 attempts per track — the exact query, then one cleaned-up
// fallback combining suffix-stripping and feat.-stripping in a single shot.
// Deliberately capped at 2 (not 4): a large batch of misses can mean
// thousands of tracks, and each extra variant multiplies Spotify API calls
// across the whole batch — a prior 4-variant version tripped a ~22-hour
// app-level rate limit on a ~2500-track library.
function searchVariants(title: string, artist: string): { title: string; artist: string }[] {
  // Strip "(Remix)", "(Extended Mix)", "[Radio Edit]", "- Radio Edit" etc.
  const cleanTitle = title
    .replace(/\s*[\(\[][^)\]]*(?:mix|remix|edit|version|rework|vip|dub|bootleg)[^)\]]*[\)\]]/gi, "")
    .replace(/\s*-\s*(?:[\w\s]*)(mix|remix|edit|version|rework|vip|dub|bootleg)\s*$/i, "")
    .trim();
  // Drop "feat./ft./featuring X" and any secondary credited artists
  const cleanArtist = artist.split(/[,;]|feat\.?|ft\.?|featuring|&|\bx\b/i)[0].trim();

  const fallback = { title: cleanTitle || title, artist: cleanArtist || artist };
  const exact = { title, artist };
  if (fallback.title.toLowerCase() === exact.title.toLowerCase() && fallback.artist.toLowerCase() === exact.artist.toLowerCase()) {
    return [exact];
  }
  return [exact, fallback];
}

async function searchSpotify(token: string, title: string, artist: string): Promise<{ result: CacheEntry; rateLimited: number | null }> {
  for (const variant of searchVariants(title, artist)) {
    const q = encodeURIComponent(variant.artist ? `${variant.title} ${variant.artist}` : variant.title);
    const res = await fetch(
      `https://api.spotify.com/v1/search?q=${q}&type=track&limit=1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.status === 429) {
      return { result: null, rateLimited: parseRetryAfter(res.headers.get("Retry-After") ?? "30") };
    }
    if (!res.ok) continue;
    const data = await res.json() as {
      tracks?: { items?: { uri: string; name: string; artists: { name: string }[] }[] };
    };
    const item = data.tracks?.items?.[0];
    if (item) {
      return { result: { uri: item.uri, name: item.name, artistName: item.artists[0]?.name ?? artist }, rateLimited: null };
    }
    await sleep(80); // stay polite between variant attempts on the same track
  }
  return { result: null, rateLimited: null };
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("Authorization");
  const spotifyToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!spotifyToken) {
    const session = await getServerSession(authOptions);
    if (!session?.accessToken) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }
  }
  const token = spotifyToken ?? (await getServerSession(authOptions))?.accessToken!;

  const body = await req.json() as { tracks?: { artist: string; title: string }[]; bypassCache?: boolean };
  const inputTracks = (body.tracks ?? []).filter(t => t.artist && t.title);
  const bypassCache = !!body.bypassCache;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // Padding comment flushes past browsers' 1 KB SSE buffer
        controller.enqueue(encoder.encode(`: ${"x".repeat(1024)}\n\n`));

        send({ type: "start", total: inputTracks.length });

        const spotifyResults: CacheEntry[] = [];
        let retryAfter: number | null = null;
        const initialCacheSize = spotifyCache.size;
        let cacheHits = 0;
        let newHits = 0;
        let misses = 0;

        for (let i = 0; i < inputTracks.length; i++) {
          const t = inputTracks[i];
          const cacheKey = `${t.title}|||${t.artist}`.toLowerCase();

          if (!bypassCache && spotifyCache.has(cacheKey)) {
            spotifyResults.push(spotifyCache.get(cacheKey)!);
            cacheHits++;
            send({ type: "progress", current: i + 1, total: inputTracks.length, cached: true });
            continue;
          }

          if (retryAfter !== null) {
            spotifyResults.push(null);
            send({ type: "progress", current: i + 1, total: inputTracks.length, skipped: true });
            continue;
          }

          const { result, rateLimited } = await searchSpotify(token, t.title, t.artist);

          if (rateLimited !== null) {
            retryAfter = rateLimited;
            spotifyResults.push(null);
            send({ type: "progress", current: i + 1, total: inputTracks.length, skipped: true });
            continue;
          }

          if (!result) misses++; else newHits++;
          spotifyCache.set(cacheKey, result);
          spotifyResults.push(result);

          send({ type: "progress", current: i + 1, total: inputTracks.length });
          await sleep(120);
        }

        if (spotifyCache.size > initialCacheSize) saveCacheToDisk();

        const matched = spotifyResults.filter(t => t !== null).length;
        console.log(
          `[ai-dj-library/lookup] matched ${matched}/${inputTracks.length} ` +
          `(${cacheHits} cached, ${newHits} new, ${misses} misses)` +
          (retryAfter !== null ? ` rate-limited retry-after ${retryAfter}s` : "")
        );

        const tracks = inputTracks.map((t, i) => ({
          uri: spotifyResults[i]?.uri ?? "",
          name: spotifyResults[i]?.name ?? t.title,
          artistName: spotifyResults[i]?.artistName ?? t.artist,
          originalTitle: t.title,
          originalArtist: t.artist,
        }));

        send({ type: "done", tracks, retryAfter });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error(`[ai-dj-library/lookup] error: ${message}`);
        send({ type: "error", error: message });
      } finally {
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
