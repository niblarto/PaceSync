import { readFile, writeFile } from "fs/promises";
import path from "path";
import { activeCsvPath } from "@/lib/running-playlist-config";
import { deezerDurationMs, fetchFeatures, lastfmDurationMs, sleep, TrackFeatures } from "@/lib/track-enrich";

// Live progress for the Settings page to poll — a heal sweep on a large
// library (thousands of rows) can run for a long time, and previously gave
// no visibility beyond server logs. Best-effort file write; never blocks
// or fails the heal itself.
export interface HealProgress {
  running: boolean;
  phase: "features" | "duration" | null;
  current: number;
  total: number;
  healedSoFar: number;
  startedAt: string | null;
  finishedAt: string | null;
}

const PROGRESS_PATH = path.join(process.cwd(), "csv-heal-progress.json");

async function writeProgress(p: HealProgress): Promise<void> {
  try { await writeFile(PROGRESS_PATH, JSON.stringify(p), "utf8"); } catch { /* best-effort */ }
}

export async function getHealProgress(): Promise<HealProgress | null> {
  try {
    return JSON.parse(await readFile(PROGRESS_PATH, "utf8")) as HealProgress;
  } catch {
    return null;
  }
}

// Sweeps the active library CSV for rows with missing data and backfills it
// from the available sources. Run after every CSV write (track add, feature
// update, playlist upload) so no row can sit there with blanks — a missing
// Duration (ms) once crashed the AI DJ mixer ("cannot convert float NaN to
// integer"), and missing Tempo/Key/Mode/Energy silently shrink the BPM pool.
//
// Sources, in order:
//   Duration (ms):  Spotify GET /v1/tracks/{id} (client-credentials token;
//                   singles — the batch ids= endpoint 403s on this app),
//                   then Deezer search, then Last.fm track.getInfo.
//   Tempo/Key/Mode/Energy/Danceability/Valence: ReccoBeats by Spotify ID,
//                   with the Deezer-ISRC fallback (lib/track-enrich).
//
// All lookups are throttled like the BBC/library lookups: sequential with a
// polite gap, honoring Retry-After on 429.

export interface HealResult {
  checked: number;   // rows examined
  healed: number;    // rows that gained at least one value
  incomplete: number; // rows still missing something after the sweep
}

const FEATURE_COLS: Array<[string, keyof TrackFeatures]> = [
  ["Tempo", "tempo"], ["Key", "key"], ["Mode", "mode"],
  ["Energy", "energy"], ["Danceability", "danceability"], ["Valence", "valence"],
];

// Quote-aware CSV row parser (same semantics as the client-side one)
function parseCsvRow(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === "," && !inQuotes) { result.push(current); current = ""; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function isBlank(v: string | undefined): boolean {
  const t = v?.trim().toLowerCase();
  return !t || t === "nan";
}

function parseRetryAfter(raw: string): number {
  const delta = parseInt(raw, 10);
  if (!isNaN(delta)) return delta;
  const date = new Date(raw).getTime();
  if (!isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return 30;
}

async function spotifyAppToken(): Promise<string | null> {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;
  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) return null;
    return ((await res.json()) as { access_token: string }).access_token;
  } catch {
    return null;
  }
}

// Single-track Spotify duration; returns undefined on a long rate limit so
// the caller stops hitting Spotify for the rest of the sweep.
async function spotifyDurationMs(id: string, token: string): Promise<number | null | undefined> {
  let res = await fetch(`https://api.spotify.com/v1/tracks/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 429) {
    const wait = parseRetryAfter(res.headers.get("Retry-After") ?? "30");
    console.log(`[csv-heal] Spotify 429 — retry-after ${wait}s`);
    if (wait > 10) return undefined;
    await sleep(wait * 1000);
    res = await fetch(`https://api.spotify.com/v1/tracks/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }
  if (!res.ok) return null;
  const t = (await res.json()) as { duration_ms?: number };
  return typeof t.duration_ms === "number" ? t.duration_ms : null;
}

export interface IncompleteTrack {
  name: string;
  artist: string;
  missing: string[]; // column names with no value
}

// Read-only scan: which rows are missing data the AI DJ needs? Used to warn
// before a mix build (the mixer excludes these rows rather than crashing).
export async function scanActiveCsv(): Promise<{ checked: number; incomplete: IncompleteTrack[] }> {
  const csv = await readFile(activeCsvPath(), "utf8");
  const lines = csv.split("\n");
  const headers = parseCsvRow(lines[0].replace(/^﻿/, "")).map(h => h.trim());
  const col = (name: string) => headers.indexOf(name);
  const idxUri = col("Track URI");
  const idxName = col("Track Name");
  const idxArtist = col("Artist Name(s)");
  const watched = ["Duration (ms)", ...FEATURE_COLS.map(([h]) => h)];
  const incomplete: IncompleteTrack[] = [];
  let checked = 0;
  if (idxUri === -1) return { checked, incomplete };
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    checked++;
    const row = parseCsvRow(lines[i]);
    if (!row[idxUri]?.trim()) continue;
    const missing = watched.filter(h => {
      const idx = col(h);
      return idx !== -1 && isBlank(row[idx]);
    });
    if (missing.length > 0) {
      incomplete.push({
        name: row[idxName]?.trim() || row[idxUri].trim(),
        artist: row[idxArtist]?.trim() ?? "",
        missing,
      });
    }
  }
  return { checked, incomplete };
}

// One heal at a time: the write routes fire this after every CSV change and
// overlapping sweeps would race on the file.
let inFlight: Promise<HealResult> | null = null;

export function healActiveCsv(): Promise<HealResult> {
  if (!inFlight) {
    inFlight = doHeal().finally(() => { inFlight = null; });
  }
  return inFlight;
}

async function doHeal(): Promise<HealResult> {
  const csvPath = activeCsvPath();
  const csv = await readFile(csvPath, "utf8");
  const lines = csv.split("\n");
  const headers = parseCsvRow(lines[0].replace(/^﻿/, "")).map(h => h.trim());
  const col = (name: string) => headers.indexOf(name);
  const idxUri = col("Track URI");
  const idxName = col("Track Name");
  const idxArtist = col("Artist Name(s)");
  const idxDuration = col("Duration (ms)");
  if (idxUri === -1) return { checked: 0, healed: 0, incomplete: 0 };

  interface Gap {
    line: number;
    row: string[];
    id: string;
    name: string;
    artist: string;
    needsDuration: boolean;
    needsFeatures: boolean;
  }
  const gaps: Gap[] = [];
  let checked = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    checked++;
    const row = parseCsvRow(lines[i]);
    const uri = row[idxUri]?.trim() ?? "";
    if (!uri.startsWith("spotify:track:")) continue;
    const needsDuration = idxDuration !== -1 && isBlank(row[idxDuration]);
    const needsFeatures = FEATURE_COLS.some(([h]) => {
      const idx = col(h);
      return idx !== -1 && isBlank(row[idx]);
    });
    if (!needsDuration && !needsFeatures) continue;
    gaps.push({
      line: i, row, id: uri.split(":").pop()!,
      name: row[idxName]?.trim() ?? "", artist: row[idxArtist]?.trim() ?? "",
      needsDuration, needsFeatures,
    });
  }
  if (gaps.length === 0) {
    await writeProgress({ running: false, phase: null, current: 0, total: 0, healedSoFar: 0, startedAt: null, finishedAt: new Date().toISOString() });
    return { checked, healed: 0, incomplete: 0 };
  }

  console.log(`[csv-heal] ${gaps.length}/${checked} rows missing data — backfilling`);
  const startedAt = new Date().toISOString();
  await writeProgress({ running: true, phase: "features", current: 0, total: gaps.length, healedSoFar: 0, startedAt, finishedAt: null });

  // Write whatever's changed in `gaps` back into `lines` and flush to disk —
  // called after each phase so a restart mid-sweep (e.g. a redeploy) only
  // loses whatever hadn't been fetched yet, not the whole sweep's progress.
  const flush = async (): Promise<number> => {
    let healedNow = 0;
    for (const g of gaps) {
      const rebuilt = g.row.map(csvEscape).join(",");
      if (rebuilt !== lines[g.line]) {
        lines[g.line] = rebuilt;
        healedNow++;
      }
    }
    if (healedNow > 0) await writeFile(csvPath, lines.join("\n"), "utf8");
    return healedNow;
  };

  // Audio features via ReccoBeats (+ Deezer-ISRC fallback) first: one
  // batched call covers the whole gap list (fast), and Tempo/Energy is what
  // the dashboard actually requires to load a library at all — Duration
  // below is comparatively slow (sequential, one request per row) and
  // doesn't block anything the app needs immediately.
  const featureGaps = gaps.filter(g => g.needsFeatures);
  if (featureGaps.length > 0) {
    try {
      const features = await fetchFeatures(
        featureGaps.map(g => ({ id: g.id, name: g.name || undefined, artist: g.artist || undefined })),
      );
      for (const g of featureGaps) {
        const f = features[g.id];
        if (!f) continue;
        for (const [header, key] of FEATURE_COLS) {
          const idx = col(header);
          if (idx !== -1 && isBlank(g.row[idx])) g.row[idx] = String(f[key]);
        }
        g.needsFeatures = false;
      }
    } catch (e) {
      console.warn(`[csv-heal] feature lookup failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  let healed = await flush();
  const featuresHealed = healed;
  console.log(`[csv-heal] features pass: healed ${featuresHealed} rows so far`);
  await writeProgress({ running: true, phase: "duration", current: 0, total: gaps.filter(g => g.needsDuration).length, healedSoFar: featuresHealed, startedAt, finishedAt: null });

  // Durations: Spotify singles first, Deezer for whatever's left. Slow
  // (sequential, ~1 request/row) — flushed incrementally every 25 rows so
  // a restart doesn't lose an hour of progress on a large library, with a
  // progress line every 50 rows so a long sweep can be watched via
  // `journalctl -u running-playlist -f` (or the Settings page) instead of
  // looking like it's hung.
  let token: string | null | undefined = undefined; // lazy — only fetch if needed
  const durationGaps = gaps.filter(g => g.needsDuration);
  let durationHealed = 0;
  for (let i = 0; i < durationGaps.length; i++) {
    const g = durationGaps[i];
    let ms: number | null | undefined = null;
    if (token !== null) {
      if (token === undefined) token = await spotifyAppToken();
      if (token) {
        ms = await spotifyDurationMs(g.id, token);
        if (ms === undefined) { token = null; ms = null; } // long 429 — stop using Spotify
        await sleep(120);
      }
    }
    if (ms == null && g.name && g.artist) {
      try { ms = await deezerDurationMs(g.name, g.artist); } catch { ms = null; }
      await sleep(150);
    }
    if (ms == null && g.name && g.artist) {
      try { ms = await lastfmDurationMs(g.name, g.artist); } catch { ms = null; }
      await sleep(200); // Last.fm asks for <=5 req/s
    }
    if (ms != null) {
      g.row[idxDuration] = String(Math.round(ms));
      g.needsDuration = false;
      durationHealed++;
    }
    if ((i + 1) % 25 === 0) await flush();
    if ((i + 1) % 50 === 0 || i === durationGaps.length - 1) {
      console.log(`[csv-heal] duration pass: ${i + 1}/${durationGaps.length} rows checked, ${durationHealed} filled`);
      await writeProgress({ running: true, phase: "duration", current: i + 1, total: durationGaps.length, healedSoFar: featuresHealed + durationHealed, startedAt, finishedAt: null });
    }
  }

  const durationFlushHealed = await flush();
  healed = featuresHealed + durationFlushHealed;
  const incomplete = gaps.filter(g => g.needsDuration || g.needsFeatures).length;
  console.log(`[csv-heal] healed ${healed} rows${incomplete ? `, ${incomplete} still incomplete` : ""}`);
  await writeProgress({ running: false, phase: null, current: durationGaps.length, total: durationGaps.length, healedSoFar: healed, startedAt, finishedAt: new Date().toISOString() });
  return { checked, healed, incomplete };
}
