import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const CACHE_DIR = path.join(process.cwd(), "cache", "art");
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

const urlCache = new Map<string, string | null>();

// Single shared queue for all Deezer lookups (GET requests + prewarm)
const queue: Array<() => void> = [];
let running = 0;
const MAX_CONCURRENT = 3;

function scheduleNext() {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    running++;
    queue.shift()!();
  }
}

async function deezerLookup(artist: string, title: string): Promise<string | null> {
  const key = `${title}|||${artist}`.toLowerCase();
  if (urlCache.has(key)) return urlCache.get(key) ?? null;
  try {
    const q = encodeURIComponent(`${title} ${artist}`);
    const res = await fetch(`https://api.deezer.com/search?q=${q}&limit=1`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null; // don't cache HTTP errors — allow retry
    const data = await res.json() as { data?: { album?: { cover_medium?: string } }[] };
    const raw = data.data?.[0]?.album?.cover_medium ?? null;
    const url = raw ? raw.replace("250x250", "500x500") : null;
    urlCache.set(key, url);
    return url;
  } catch {
    urlCache.set(key, null);
    return null;
  }
}

function queuedLookup(artist: string, title: string): Promise<string | null> {
  return new Promise(resolve => {
    queue.push(async () => {
      try { resolve(await deezerLookup(artist, title)); }
      finally { running--; scheduleNext(); }
    });
    scheduleNext();
  });
}

function diskKey(artist: string, title: string): string {
  return createHash("md5").update(`${title}|||${artist}`.toLowerCase()).digest("hex");
}

// Full fetch-and-cache pipeline used by both GET and prewarm
async function fetchAndCache(artist: string, title: string): Promise<Uint8Array | null> {
  const filePath = path.join(CACHE_DIR, `${diskKey(artist, title)}.jpg`);
  if (fs.existsSync(filePath)) return new Uint8Array(fs.readFileSync(filePath));

  const artUrl = await queuedLookup(artist, title);
  if (!artUrl) return null;

  try {
    const img = await fetch(artUrl, { signal: AbortSignal.timeout(8000) });
    if (!img.ok) return null;
    const arr = await img.arrayBuffer();
    const buf = Buffer.from(arr);
    try { fs.writeFileSync(filePath, buf); } catch {}
    return new Uint8Array(arr);
  } catch {
    return null;
  }
}

// GET /api/itunes-art?artist=X&title=Y  — returns image bytes
export async function GET(req: NextRequest) {
  const artist = req.nextUrl.searchParams.get("artist") ?? "";
  const title  = req.nextUrl.searchParams.get("title") ?? "";
  if (!title) return new Response(null, { status: 404 });

  // Disk hit: instant response, no Deezer call
  const filePath = path.join(CACHE_DIR, `${diskKey(artist, title)}.jpg`);
  if (fs.existsSync(filePath)) {
    const cached = fs.readFileSync(filePath);
    return new Response(new Uint8Array(cached), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=2592000" },
    });
  }

  const buf = await fetchAndCache(artist, title);
  if (!buf) return new Response(null, { status: 404 });

  return new Response(new Uint8Array(buf), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=2592000" },
  });
}

// POST /api/itunes-art  — prewarm cache for a list of tracks (fire-and-forget)
let prewarming = false;

export async function POST(req: NextRequest) {
  const { tracks } = await req.json() as { tracks: Array<{ artist: string; title: string }> };
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return NextResponse.json({ error: "no tracks" }, { status: 400 });
  }

  if (prewarming) return NextResponse.json({ status: "already_running" });

  // Start background processing — runs in the event loop after response is sent
  prewarming = true;
  Promise.all(tracks.map(({ artist, title }) => fetchAndCache(artist, title).catch(() => {})))
    .catch(() => {})
    .finally(() => { prewarming = false; });

  return NextResponse.json({ started: true, total: tracks.length });
}
