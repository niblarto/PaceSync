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

  const body = await req.json() as { tracks?: { artist: string; title: string }[] };
  const inputTracks = (body.tracks ?? []).filter(t => t.artist && t.title);

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

          if (spotifyCache.has(cacheKey)) {
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

          const q = encodeURIComponent(`${t.title} ${t.artist}`);
          const res = await fetch(
            `https://api.spotify.com/v1/search?q=${q}&type=track&limit=1`,
            { headers: { Authorization: `Bearer ${token}` } }
          );

          if (res.status === 429) {
            retryAfter = parseRetryAfter(res.headers.get("Retry-After") ?? "30");
            spotifyResults.push(null);
            send({ type: "progress", current: i + 1, total: inputTracks.length, skipped: true });
            continue;
          }

          if (!res.ok) {
            spotifyResults.push(null);
            misses++;
          } else {
            const data = await res.json() as {
              tracks?: { items?: { uri: string; name: string; artists: { name: string }[] }[] };
            };
            const item = data.tracks?.items?.[0];
            const result: CacheEntry = item
              ? { uri: item.uri, name: item.name, artistName: item.artists[0]?.name ?? t.artist }
              : null;
            if (!result) misses++; else newHits++;
            spotifyCache.set(cacheKey, result);
            spotifyResults.push(result);
          }

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
