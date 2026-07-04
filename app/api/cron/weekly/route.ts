import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getFreshToken } from "@/lib/tokenStore";
import { loadNtfyTopic } from "@/lib/ntfy-config";
import { appendCronLog } from "@/lib/cron-log";
import fs from "fs";
import path from "path";

import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";

// Resolved per call so a playlist change in Settings applies immediately.
const runningPlaylistId = () => loadRunningPlaylistConfig().id;
const CACHE_FILE = path.join(process.cwd(), "spotify-cache.json");
const BBC_PROGRAMMES_FILE = path.join(process.cwd(), "bbc-programmes.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

const BBC_DEFAULTS = [
  { pid: "m001j52w", name: "6 Music Playlist" },
  { pid: "m0012v02", name: "6 Music's Indie Forever" },
  { pid: "m002xsbn", name: "Lauren Laverne" },
];

function loadBbcProgrammes(): { pid: string; name: string }[] {
  try {
    const data = JSON.parse(fs.readFileSync(BBC_PROGRAMMES_FILE, "utf-8")) as { pid: string; name: string }[];
    if (Array.isArray(data) && data.length > 0) return data;
  } catch {}
  return BBC_DEFAULTS;
}

// ── ntfy.sh ────────────────────────────────────────────────────────────────

async function notify(message: string, options: { title?: string; tags?: string; priority?: string } = {}) {
  const topic = loadNtfyTopic() ?? process.env.NTFY_TOPIC ?? "";
  if (!topic) return;
  try {
    const headers: Record<string, string> = { "Content-Type": "text/plain" };
    if (options.title) headers["Title"] = options.title;
    if (options.tags) headers["Tags"] = options.tags;
    if (options.priority) headers["Priority"] = options.priority;
    await fetch(`https://ntfy.sh/${topic}`, { method: "POST", headers, body: message });
  } catch (e) {
    console.warn("[cron] ntfy failed:", e);
  }
}

// ── Disk cache ─────────────────────────────────────────────────────────────

type CacheEntry = { uri: string; name: string; artistName: string } | null;

function loadCache(): Map<string, CacheEntry> {
  const cache = new Map<string, CacheEntry>();
  try {
    const obj = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")) as Record<string, CacheEntry>;
    for (const [k, v] of Object.entries(obj)) cache.set(k, v);
  } catch { /* empty */ }
  return cache;
}

function saveCache(cache: Map<string, CacheEntry>) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(Array.from(cache.entries()))), "utf-8");
  } catch (e) {
    console.warn("[cron] cache write failed:", e);
  }
}

// ── BBC helpers ────────────────────────────────────────────────────────────

interface SegmentEvent {
  segment: { type: string; artist?: string; track_title?: string };
}

function decodeHtmlEntities(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'");
}

function extractProgramName(html: string, fallback: string) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  let name = decodeHtmlEntities(m?.[1] ?? "");
  name = name.replace(/\s*[-–|]\s*(BBC|bbc).*$/i, "").replace(/^(BBC|bbc)\s+/i, "").trim();
  return name || `BBC ${fallback}`;
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

async function findLatestEpisodePid(brandPid: string): Promise<string> {
  // 1. BBC Programmes JSON API — newest-first, elements[0] = latest broadcast
  try {
    const res = await fetch(`https://www.bbc.co.uk/programmes/${brandPid}/episodes.json?limit=1`, {
      headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json() as any;
      const elements: any[] = data?.episodes?.elements ?? [];
      const pid: unknown = elements[0]?.pid;
      console.log(`[cron] episodes.json for ${brandPid}: total=${data?.episodes?.total} pid=${pid}`);
      if (typeof pid === "string" && pid !== brandPid) return pid;
    }
  } catch { /* try HTML */ }

  // 2. HTML scraping: take lexicographic max of all data-pid values found
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
          console.log(`[cron] data-pids for ${brandPid} from ${url.split("/").slice(-2).join("/")}: max=${latest}`);
          return latest;
        }
      }
    } catch { /* try next */ }
  }

  return brandPid;
}

async function getSegments(pid: string): Promise<{ artist: string; title: string }[] | null> {
  const res = await fetch(`https://www.bbc.co.uk/programmes/${pid}/segments.json`, {
    headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`BBC segments ${res.status}`);
  const data = await res.json() as { segment_events?: SegmentEvent[] };
  return (data.segment_events ?? [])
    .filter(e => e.segment.type === "music" && e.segment.track_title && e.segment.artist)
    .map(e => ({ artist: e.segment.artist!, title: e.segment.track_title! }));
}

function parseRetryAfter(raw: string) {
  const delta = parseInt(raw, 10);
  if (!isNaN(delta)) return delta;
  const date = new Date(raw).getTime();
  if (!isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return 30;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Load one BBC playlist and add to Running playlist ──────────────────────

async function processPlaylist(
  pid: string,
  name: string,
  token: string,
  cache: Map<string, CacheEntry>
): Promise<{ found: number; matched: number; skipped: number; retryAfter: number | null }> {
  const pageRes = await fetch(`https://www.bbc.co.uk/programmes/${pid}`, {
    headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000),
  });
  if (!pageRes.ok) throw new Error(`BBC page ${pageRes.status}`);
  const html = await pageRes.text();
  const episodePid = await findLatestEpisodePid(pid);

  let tracks = await getSegments(episodePid);
  if (tracks === null && episodePid !== pid) tracks = await getSegments(pid);
  if (tracks === null) throw new Error("No segments data");

  const uris: string[] = [];
  let retryAfter: number | null = null;
  let newCacheEntries = 0;

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const key = `${t.title}|||${t.artist}`.toLowerCase();

    if (cache.has(key)) {
      const entry = cache.get(key)!;
      if (entry?.uri) uris.push(entry.uri);
      continue;
    }

    if (retryAfter !== null) continue;

    const q = encodeURIComponent(`${t.title} ${t.artist}`);
    const res = await fetch(`https://api.spotify.com/v1/search?q=${q}&type=track&limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 429) {
      retryAfter = parseRetryAfter(res.headers.get("Retry-After") ?? "30");
      continue;
    }

    if (res.ok) {
      const data = await res.json() as {
        tracks?: { items?: { uri: string; name: string; artists: { name: string }[] }[] };
      };
      const item = data.tracks?.items?.[0];
      const entry: CacheEntry = item
        ? { uri: item.uri, name: item.name, artistName: item.artists[0]?.name ?? t.artist }
        : null;
      cache.set(key, entry);
      newCacheEntries++;
      if (entry?.uri) uris.push(entry.uri);
    }

    await sleep(150);
  }

  if (newCacheEntries > 0) saveCache(cache);

  // Add matched URIs to Running playlist in chunks of 100
  for (let i = 0; i < uris.length; i += 100) {
    const res = await fetch(`https://api.spotify.com/v1/playlists/${runningPlaylistId()}/items`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: uris.slice(i, i + 100) }),
    });
    if (!res.ok) throw new Error(`Add tracks ${res.status}: ${await res.text()}`);
  }

  return { found: tracks.length, matched: uris.length, skipped: tracks.length - uris.length, retryAfter };
}

// ── Dedup ──────────────────────────────────────────────────────────────────

async function dedup(token: string): Promise<{ removed: number; remaining: number }> {
  const uris: string[] = [];
  let url: string | null = `https://api.spotify.com/v1/playlists/${runningPlaylistId()}/items?limit=100`;

  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Read playlist ${res.status}`);
    const data = await res.json() as any;
    for (const item of data?.items ?? []) {
      const uri = item?.track?.uri ?? item?.item?.uri;
      if (typeof uri === "string" && uri.startsWith("spotify:track:")) uris.push(uri);
    }
    url = data?.next ?? null;
  }

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const uri of uris) {
    if (!seen.has(uri)) { seen.add(uri); deduped.push(uri); }
  }

  const removed = uris.length - deduped.length;
  if (removed === 0) return { removed: 0, remaining: uris.length };

  const chunks: string[][] = [];
  for (let i = 0; i < deduped.length; i += 100) chunks.push(deduped.slice(i, i + 100));

  const putRes = await fetch(`https://api.spotify.com/v1/playlists/${runningPlaylistId()}/items`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ uris: chunks[0] ?? [] }),
  });
  if (!putRes.ok) throw new Error(`PUT ${putRes.status}: ${await putRes.text()}`);

  for (let i = 1; i < chunks.length; i++) {
    const postRes = await fetch(`https://api.spotify.com/v1/playlists/${runningPlaylistId()}/items`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: chunks[i] }),
    });
    if (!postRes.ok) throw new Error(`POST ${postRes.status}: ${await postRes.text()}`);
  }

  return { removed, remaining: deduped.length };
}

// ── Shared run logic ───────────────────────────────────────────────────────

export interface CronResult {
  name: string;
  found: number;
  matched: number;
  error?: string;
  rateLimited?: boolean;
  retryAfter?: number;
}

async function runUpdate(): Promise<{
  ok: boolean;
  programmeResults: CronResult[];
  dedupRemoved: number;
  dedupRemaining: number;
  dedupError?: string;
  totalMatched: number;
  errors: number;
}> {
  const bbcPlaylists = loadBbcProgrammes();
  appendCronLog("BBC refresh", `Started — ${bbcPlaylists.length} programme${bbcPlaylists.length !== 1 ? "s" : ""}`);

  const programmeList = bbcPlaylists.map(p => `• ${p.name}`).join("\n");
  await notify(
    `Processing ${bbcPlaylists.length} programme${bbcPlaylists.length !== 1 ? "s" : ""}:\n${programmeList}`,
    { title: "BBC Playlist Update Starting", tags: "musical_note,clipboard" }
  );

  const tokenResult = await getFreshToken();
  if (!tokenResult.ok) {
    const msg = tokenResult.reason === "no_token_file"
      ? "No saved token found — please log in at https://bpm.birch-horn.com to authorise Spotify access."
      : tokenResult.reason === "refresh_failed"
        ? "Spotify token refresh failed — your session may have expired or been revoked. Please log in again at https://bpm.birch-horn.com"
        : "Network error reaching Spotify — check the Pi's internet connection.";
    await notify(msg, { title: "❌ BBC Update — Auth Failed", tags: "x", priority: "high" });
    appendCronLog("BBC refresh", `✗ Spotify auth failed: ${tokenResult.reason}`);
    throw new Error(tokenResult.reason);
  }
  const token = tokenResult.token;

  const cache = loadCache();
  const programmeResults: CronResult[] = [];
  let errors = 0;

  for (let pi = 0; pi < bbcPlaylists.length; pi++) {
    if (pi > 0) await sleep(3000);
    const playlist = bbcPlaylists[pi];
    try {
      const r = await processPlaylist(playlist.pid, playlist.name, token, cache);
      const rateLimitNote = r.retryAfter !== null
        ? ` (rate limited — ${r.retryAfter}s wait, ${r.skipped} tracks skipped)`
        : "";
      const songWord = r.matched === 1 ? "song" : "songs";
      await notify(
        `${r.matched} ${songWord} added from ${r.found} BBC tracks${rateLimitNote}`,
        { title: `✅ ${playlist.name}`, tags: "white_check_mark,musical_note" }
      );
      programmeResults.push({
        name: playlist.name,
        found: r.found,
        matched: r.matched,
        rateLimited: r.retryAfter !== null,
        retryAfter: r.retryAfter ?? undefined,
      });
      appendCronLog("BBC refresh", `✓ ${playlist.name}: ${r.matched}/${r.found} tracks added${r.retryAfter !== null ? " (rate limited)" : ""}`);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      errors++;
      await notify(`Error: ${err}`, { title: `❌ ${playlist.name} failed`, tags: "x", priority: "high" });
      programmeResults.push({ name: playlist.name, found: 0, matched: 0, error: err });
      appendCronLog("BBC refresh", `✗ ${playlist.name}: ${err}`);
    }
  }

  const totalMatched = programmeResults.reduce((sum, r) => sum + r.matched, 0);

  // Dedup
  let dedupRemoved = 0;
  let dedupRemaining = 0;
  let dedupError: string | undefined;
  try {
    const result = await dedup(token);
    dedupRemoved = result.removed;
    dedupRemaining = result.remaining;
  } catch (e) {
    dedupError = e instanceof Error ? e.message : String(e);
    errors++;
  }

  // Final summary notification
  const lines = programmeResults.map(r =>
    r.error
      ? `❌ ${r.name}: ${r.error}`
      : `• ${r.name}: ${r.matched} song${r.matched !== 1 ? "s" : ""} added`
  );
  const dedupLine = dedupError
    ? `Dedup error: ${dedupError}`
    : dedupRemoved > 0
      ? `${dedupRemoved} duplicate${dedupRemoved !== 1 ? "s" : ""} removed · ${dedupRemaining} tracks in playlist`
      : `No duplicates · ${dedupRemaining} tracks in playlist`;

  const totalLine = `${totalMatched} new song${totalMatched !== 1 ? "s" : ""} added in total`;

  await notify(
    `${lines.join("\n")}\n\n${totalLine}\n${dedupLine}`,
    {
      title: errors === 0 ? "✅ Weekly Update Complete" : "⚠️ Weekly Update Done With Errors",
      tags: errors === 0 ? "white_check_mark" : "warning",
    }
  );

  console.log("[cron/weekly] done:", programmeResults);
  appendCronLog(
    "BBC refresh",
    errors === 0
      ? `✓ Done — ${totalMatched} new tracks, ${dedupRemoved} duplicates removed, ${dedupRemaining} in playlist`
      : `✗ Done with ${errors} error${errors !== 1 ? "s" : ""} — ${totalMatched} new tracks${dedupError ? `, dedup failed: ${dedupError}` : ""}`
  );
  return { ok: errors === 0, programmeResults, dedupRemoved, dedupRemaining, dedupError, totalMatched, errors };
}

// ── Route handler ──────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Accept either a valid cron secret header OR an authenticated session
  const cronSecret = process.env.CRON_SECRET;
  const hasCronSecret = cronSecret && req.headers.get("X-Cron-Secret") === cronSecret;
  if (!hasCronSecret) {
    const session = await getServerSession(authOptions);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runUpdate();
    return Response.json(result);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return Response.json({ error: err }, { status: 500 });
  }
}
