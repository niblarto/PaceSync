import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import fs from "fs";
import path from "path";

const DEFAULT_PID = "m001j52w";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const CACHE_FILE = path.join(process.cwd(), "spotify-cache.json");

interface SegmentEvent {
  segment: {
    type: string;
    artist?: string;
    track_title?: string;
  };
}

type CacheEntry = { uri: string; name: string; artistName: string } | null;

// Module-level cache: populated from disk on startup, persisted on each new hit
const spotifyCache = new Map<string, CacheEntry>();

function loadCacheFromDisk() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf-8");
    const obj = JSON.parse(raw) as Record<string, CacheEntry>;
    for (const [k, v] of Object.entries(obj)) {
      spotifyCache.set(k, v);
    }
    console.log(`[bbc/tracks] Loaded ${spotifyCache.size} entries from disk cache`);
  } catch {
    // File missing or corrupt — start with empty cache
  }
}

function saveCacheToDisk() {
  try {
    const obj: Record<string, CacheEntry> = Object.fromEntries(Array.from(spotifyCache.entries()));
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj), "utf-8");
  } catch (e) {
    console.warn("[bbc/tracks] Failed to write disk cache:", e);
  }
}

// Load on module init (runs once per process start)
loadCacheFromDisk();

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'");
}

function extractProgramName(html: string, fallbackPid: string): string {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  let name = decodeHtmlEntities(m?.[1] ?? "");
  name = name.replace(/\s*[-–|]\s*(BBC|bbc).*$/i, "").replace(/^(BBC|bbc)\s+/i, "").trim();
  return name || `BBC ${fallbackPid}`;
}

function extractDataPids(html: string, brandPid: string): string[] {
  const seen = new Set<string>();
  const pids: string[] = [];
  const re = /data-pid="(m0[a-z0-9]{6})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1] !== brandPid && !seen.has(m[1])) { seen.add(m[1]); pids.push(m[1]); }
  }
  return pids;
}

function formatAirDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  } catch {
    return "";
  }
}

async function fetchEpisodeDate(pid: string): Promise<string | null> {
  try {
    const res = await fetch(`https://www.bbc.co.uk/programmes/${pid}.json`, {
      headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const prog = data?.programme;
    const raw: unknown = prog?.first_broadcast_date ?? prog?.updated_time;
    return typeof raw === "string" ? formatAirDate(raw) : null;
  } catch {
    return null;
  }
}

async function findLatestEpisode(brandPid: string): Promise<{ pid: string; airDate: string | null }> {
  // 1. BBC Programmes JSON API — newest-first, elements[0] = latest broadcast
  try {
    const res = await fetch(`https://www.bbc.co.uk/programmes/${brandPid}/episodes.json?limit=1`, {
      headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json() as any;
      const elements: any[] = data?.episodes?.elements ?? [];
      const ep = elements[0];
      const pid: unknown = ep?.pid;
      const rawDate: unknown = ep?.first_broadcast_date;
      console.log(`[bbc/tracks] episodes.json for ${brandPid}: total=${data?.episodes?.total} pid=${pid} date=${rawDate}`);
      if (typeof pid === "string" && pid !== brandPid) {
        return { pid, airDate: typeof rawDate === "string" ? formatAirDate(rawDate) : null };
      }
    }
  } catch { /* try HTML */ }

  // 2. HTML scraping: take lexicographic max of all data-pid values found
  //    (BBC PIDs are sequential — highest value = most recently created episode)
  for (const url of [
    `https://www.bbc.co.uk/programmes/${brandPid}/episodes/player`,
    `https://www.bbc.co.uk/iplayer/episodes/${brandPid}`,
  ]) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const pids = extractDataPids(await res.text(), brandPid);
        if (pids.length > 0) {
          const latest = [...pids].sort().at(-1)!;
          console.log(`[bbc/tracks] data-pids for ${brandPid} from ${url.split("/").slice(-2).join("/")}: max=${latest}`);
          return { pid: latest, airDate: null };
        }
      }
    } catch { /* try next */ }
  }

  return { pid: brandPid, airDate: null };
}

async function getSegmentTracks(pid: string): Promise<{ artist: string; title: string }[] | null> {
  const res = await fetch(`https://www.bbc.co.uk/programmes/${pid}/segments.json`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`BBC segments API returned ${res.status}`);
  const data = await res.json() as { segment_events?: SegmentEvent[] };
  return (data.segment_events ?? [])
    .filter(e => e.segment.type === "music" && e.segment.track_title && e.segment.artist)
    .map(e => ({ artist: e.segment.artist!, title: e.segment.track_title! }));
}

function parseRetryAfter(raw: string): number {
  const delta = parseInt(raw, 10);
  if (!isNaN(delta)) return delta;
  const date = new Date(raw).getTime();
  if (!isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return 30;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("Authorization");
  const spotifyToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!spotifyToken) {
    const session = await getServerSession(authOptions);
    if (!session?.accessToken) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }
  }
  const token = spotifyToken ?? (await getServerSession(authOptions))?.accessToken!;
  const brandPid = req.nextUrl.searchParams.get("pid") ?? DEFAULT_PID;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // Padding comment flushes past browsers' 1 KB SSE buffer
        controller.enqueue(encoder.encode(`: ${"x".repeat(1024)}\n\n`));

        const pageRes = await fetch(`https://www.bbc.co.uk/programmes/${brandPid}`, {
          headers: { "User-Agent": UA },
          signal: AbortSignal.timeout(10000),
        });
        if (!pageRes.ok) throw new Error(`BBC page returned ${pageRes.status}`);
        const html = await pageRes.text();

        const programName = extractProgramName(html, brandPid);
        const { pid: episodePid, airDate: rawAirDate } = await findLatestEpisode(brandPid);
        const airDate = rawAirDate ?? await fetchEpisodeDate(episodePid);
        console.log(`[bbc/tracks] brand=${brandPid} episode=${episodePid} name="${programName}" airDate="${airDate}" cache=${spotifyCache.size}`);

        let bbcTracks = await getSegmentTracks(episodePid);
        if (bbcTracks === null && episodePid !== brandPid) {
          console.log(`[bbc/tracks] episode 404, trying brand PID directly`);
          bbcTracks = await getSegmentTracks(brandPid);
        }
        if (bbcTracks === null) throw new Error("No segments data found for this programme");
        console.log(`[bbc/tracks] ${bbcTracks.length} BBC segments`);

        send({ type: "start", total: bbcTracks.length, programName, episodePid, airDate });

        const spotifyResults: CacheEntry[] = [];
        let retryAfter: number | null = null;
        const initialCacheSize = spotifyCache.size;
        let cacheHits = 0;
        let newHits = 0;
        let misses = 0;

        for (let i = 0; i < bbcTracks.length; i++) {
          const t = bbcTracks[i];
          const cacheKey = `${t.title}|||${t.artist}`.toLowerCase();

          if (spotifyCache.has(cacheKey)) {
            spotifyResults.push(spotifyCache.get(cacheKey)!);
            cacheHits++;
            send({ type: "progress", current: i + 1, total: bbcTracks.length, cached: true });
            continue;
          }

          if (retryAfter !== null) {
            spotifyResults.push(null);
            send({ type: "progress", current: i + 1, total: bbcTracks.length, skipped: true });
            continue;
          }

          const q = encodeURIComponent(`${t.title} ${t.artist}`);
          const res = await fetch(
            `https://api.spotify.com/v1/search?q=${q}&type=track&limit=1`,
            { headers: { Authorization: `Bearer ${token}` } }
          );

          if (res.status === 429) {
            retryAfter = parseRetryAfter(res.headers.get("Retry-After") ?? "30");
            console.log(`[bbc/tracks] 429 on "${t.title}" by "${t.artist}" — retry-after ${retryAfter}s`);
            spotifyResults.push(null);
            send({ type: "progress", current: i + 1, total: bbcTracks.length, skipped: true });
            continue;
          }

          if (!res.ok) {
            console.log(`[bbc/tracks] search HTTP ${res.status} for "${t.title}" by "${t.artist}"`);
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
            if (!result) {
              console.log(`[bbc/tracks] no match for "${t.title}" by "${t.artist}"`);
              misses++;
            } else {
              newHits++;
            }
            spotifyCache.set(cacheKey, result);
            spotifyResults.push(result);
          }

          send({ type: "progress", current: i + 1, total: bbcTracks.length });
          await sleep(120);
        }

        // Persist any new entries to disk (including null/not-found to avoid re-searching)
        if (spotifyCache.size > initialCacheSize) saveCacheToDisk();

        const matched = spotifyResults.filter(t => t !== null).length;
        console.log(
          `[bbc/tracks] matched ${matched}/${bbcTracks.length} ` +
          `(${cacheHits} cached, ${newHits} new, ${misses} misses)` +
          (retryAfter !== null ? ` rate-limited retry-after ${retryAfter}s` : "")
        );

        const tracks = bbcTracks.map((t, i) => ({
          uri: spotifyResults[i]?.uri ?? "",
          name: spotifyResults[i]?.name ?? t.title,
          artistName: spotifyResults[i]?.artistName ?? t.artist,
        }));

        send({ type: "done", tracks, programName, airDate, retryAfter });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error(`[bbc/tracks] pid=${brandPid} error: ${message}`);
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
