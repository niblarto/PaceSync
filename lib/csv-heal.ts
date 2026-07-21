import { readFile, writeFile } from "fs/promises";
import path from "path";
import { activeCsvPath } from "@/lib/running-playlist-config";
import { deezerDurationMs, deezerGenres, fetchFeatures, lastfmDurationMs, sleep, TrackFeatures } from "@/lib/track-enrich";

// Live progress for the Settings page to poll — a heal sweep on a large
// library (thousands of rows) can run for a long time, and previously gave
// no visibility beyond server logs. Best-effort file write; never blocks
// or fails the heal itself.
export interface HealProgress {
  running: boolean;
  phase: "uris" | "features" | "duration" | "genres" | null;
  current: number;
  total: number;
  healedSoFar: number;
  startedAt: string | null;
  finishedAt: string | null;
  // ISO timestamp Spotify's rate limit is expected to clear — set when a
  // 429 is hit, cleared once the sweep either waits it out or gives up on
  // Spotify for the rest of the run.
  spotifyRetryAt: string | null;
  // Rolling log of what happened during the sweep, newest last — shown in
  // the Settings page's log window instead of only being visible via
  // `journalctl -u running-playlist -f`.
  log: { at: string; text: string }[];
}

const MAX_LOG_LINES = 200;

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

// Marks the progress file as running before healActiveCsv()'s background
// work has had a chance to write its own first update — without this, a
// client that POSTs heal-now and immediately polls heal-status can read a
// stale "not running" file left over from the previous sweep (a small
// library can finish in well under a second, well inside that race window).
export async function markHealStarting(): Promise<void> {
  await writeProgress({
    running: true, phase: null, current: 0, total: 0, healedSoFar: 0,
    startedAt: new Date().toISOString(), finishedAt: null, spotifyRetryAt: null,
    log: [{ at: new Date().toISOString(), text: "scanning for missing data…" }],
  });
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

// Sentinel returned by any Spotify call in this file on a long (>10s)
// rate limit, so the caller can stop using Spotify for the rest of the
// sweep instead of hammering it. `retryAt` is the ISO timestamp Retry-After
// resolves to, surfaced in HealProgress.spotifyRetryAt for the log window.
const SPOTIFY_LONG_RATE_LIMIT = Symbol("spotify-long-rate-limit");
interface SpotifyRateLimited { kind: typeof SPOTIFY_LONG_RATE_LIMIT; retryAt: string }

function isRateLimited(v: unknown): v is SpotifyRateLimited {
  return typeof v === "object" && v !== null && (v as SpotifyRateLimited).kind === SPOTIFY_LONG_RATE_LIMIT;
}

// Single-track Spotify duration. Genres are NOT fetched from Spotify: this
// app's artist objects come back with no `genres` field at all (Spotify
// dropped it for apps created after their Nov 2024 API changes, confirmed
// live against this app's credentials) — Deezer's album-genre lookup
// (lib/track-enrich.ts's deezerGenres) is the only working source.
async function spotifyDurationMs(id: string, token: string): Promise<number | null | SpotifyRateLimited> {
  let res = await fetch(`https://api.spotify.com/v1/tracks/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 429) {
    const wait = parseRetryAfter(res.headers.get("Retry-After") ?? "30");
    const retryAt = new Date(Date.now() + wait * 1000).toISOString();
    console.log(`[csv-heal] Spotify 429 — retry-after ${wait}s`);
    if (wait > 10) return { kind: SPOTIFY_LONG_RATE_LIMIT, retryAt };
    await sleep(wait * 1000);
    res = await fetch(`https://api.spotify.com/v1/tracks/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }
  if (!res.ok) return null;
  const t = (await res.json()) as { duration_ms?: number };
  return typeof t.duration_ms === "number" ? t.duration_ms : null;
}

// Finds a Spotify track URI for a row that has none (e.g. imported from a
// non-Spotify CSV) by searching name + artist. Same rate-limit handling as
// spotifyDurationMs. Only the top result is used — good enough for the
// common case (exact title/artist), same trade-off the BBC cron's search
// already makes.
async function spotifySearchUri(name: string, artist: string, token: string): Promise<string | null | SpotifyRateLimited> {
  const q = encodeURIComponent(`track:${name} artist:${artist}`);
  let res = await fetch(`https://api.spotify.com/v1/search?q=${q}&type=track&limit=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 429) {
    const wait = parseRetryAfter(res.headers.get("Retry-After") ?? "30");
    const retryAt = new Date(Date.now() + wait * 1000).toISOString();
    console.log(`[csv-heal] Spotify 429 (search) — retry-after ${wait}s`);
    if (wait > 10) return { kind: SPOTIFY_LONG_RATE_LIMIT, retryAt };
    await sleep(wait * 1000);
    res = await fetch(`https://api.spotify.com/v1/search?q=${q}&type=track&limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }
  if (!res.ok) return null;
  const data = await res.json() as { tracks?: { items?: { uri?: string }[] } };
  return data.tracks?.items?.[0]?.uri ?? null;
}

export interface IncompleteTrack {
  uri: string;
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
        uri: row[idxUri].trim(),
        name: row[idxName]?.trim() || row[idxUri].trim(),
        artist: row[idxArtist]?.trim() ?? "",
        missing,
      });
    }
  }
  return { checked, incomplete };
}

export interface CsvStatus {
  total: number;                    // non-blank data rows
  missingUri: number;               // no Track URI at all — can't be healed
  missingDuration: number;
  missingGenres: number;
  missingFeatures: Record<string, number>; // per FEATURE_COLS header
}

// Instant column-blank breakdown — shown on the Settings page immediately
// when "Check for missing data" is clicked, before the (slower) heal sweep
// starts, so it's clear what's actually missing before waiting on fetches.
export async function getCsvStatus(): Promise<CsvStatus> {
  const csv = await readFile(activeCsvPath(), "utf8");
  const lines = csv.split("\n");
  const headers = parseCsvRow(lines[0].replace(/^﻿/, "")).map(h => h.trim());
  const col = (name: string) => headers.indexOf(name);
  const idxUri = col("Track URI");
  const idxDuration = col("Duration (ms)");
  const idxGenres = col("Genres");

  const status: CsvStatus = {
    total: 0, missingUri: 0, missingDuration: 0, missingGenres: 0,
    missingFeatures: Object.fromEntries(FEATURE_COLS.map(([h]) => [h, 0])),
  };
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    status.total++;
    const row = parseCsvRow(lines[i]);
    if (idxUri === -1 || isBlank(row[idxUri])) { status.missingUri++; continue; }
    if (idxDuration !== -1 && isBlank(row[idxDuration])) status.missingDuration++;
    if (idxGenres !== -1 && isBlank(row[idxGenres])) status.missingGenres++;
    for (const [header] of FEATURE_COLS) {
      const idx = col(header);
      if (idx !== -1 && isBlank(row[idx])) status.missingFeatures[header]++;
    }
  }
  return status;
}

// One heal at a time per CSV: the write routes fire this after every CSV
// change and overlapping sweeps would race on the file. Also what backs the
// Settings page's "Check for missing data" button — it triggers the same
// sweep on demand instead of waiting for the next CSV write.
let inFlight: Promise<HealResult> | null = null;

// Flipped by cancelHeal() (e.g. the Settings page switching the active
// playlist mid-sweep) — checked between each row of every pass so a running
// sweep stops promptly instead of continuing to churn against a CSV that's
// no longer the active one.
let cancelRequested = false;

export function healActiveCsv(): Promise<HealResult> {
  if (!inFlight) {
    cancelRequested = false;
    inFlight = doHeal().finally(() => { inFlight = null; });
  }
  return inFlight;
}

// Stops a running sweep at the next checkpoint and clears its progress log.
// A no-op if nothing is running.
export async function cancelHeal(): Promise<void> {
  cancelRequested = true;
  await writeProgress({
    running: false, phase: null, current: 0, total: 0, healedSoFar: 0,
    startedAt: null, finishedAt: new Date().toISOString(), spotifyRetryAt: null, log: [],
  });
}

const HEAL_CANCELLED = Symbol("heal-cancelled");

async function doHeal(): Promise<HealResult> {
  try {
    return await doHealInner();
  } catch (e) {
    if (e === HEAL_CANCELLED) return { checked: 0, healed: 0, incomplete: 0 };
    throw e;
  }
}

async function doHealInner(): Promise<HealResult> {
  const csvPath = activeCsvPath();
  const csv = await readFile(csvPath, "utf8");
  const lines = csv.split("\n");
  const headers = parseCsvRow(lines[0].replace(/^﻿/, "")).map(h => h.trim());
  const col = (name: string) => headers.indexOf(name);
  const idxUri = col("Track URI");
  const idxName = col("Track Name");
  const idxArtist = col("Artist Name(s)");
  const idxDuration = col("Duration (ms)");
  const idxGenres = col("Genres");
  if (idxUri === -1) return { checked: 0, healed: 0, incomplete: 0 };

  interface Gap {
    line: number;
    row: string[];
    id: string;
    name: string;
    artist: string;
    needsDuration: boolean;
    needsFeatures: boolean;
    needsGenres: boolean;
  }
  interface UriGap {
    line: number;
    row: string[];
    name: string;
    artist: string;
  }
  const gaps: Gap[] = [];
  const uriGaps: UriGap[] = [];
  let checked = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    checked++;
    const row = parseCsvRow(lines[i]);
    const uri = row[idxUri]?.trim() ?? "";
    if (!uri.startsWith("spotify:track:")) {
      const name = row[idxName]?.trim() ?? "";
      const artist = row[idxArtist]?.trim() ?? "";
      if (name && artist) uriGaps.push({ line: i, row, name, artist });
      continue;
    }
    const needsDuration = idxDuration !== -1 && isBlank(row[idxDuration]);
    const needsFeatures = FEATURE_COLS.some(([h]) => {
      const idx = col(h);
      return idx !== -1 && isBlank(row[idx]);
    });
    const needsGenres = idxGenres !== -1 && isBlank(row[idxGenres]);
    if (!needsDuration && !needsFeatures && !needsGenres) continue;
    gaps.push({
      line: i, row, id: uri.split(":").pop()!,
      name: row[idxName]?.trim() ?? "", artist: row[idxArtist]?.trim() ?? "",
      needsDuration, needsFeatures, needsGenres,
    });
  }

  // Log lines accumulate across every writeProgress call for this sweep —
  // shown newest-last in the Settings page's log window. Capped so a huge
  // library sweep doesn't grow the progress file unboundedly.
  const log: HealProgress["log"] = [];
  const addLog = (text: string) => {
    log.push({ at: new Date().toISOString(), text });
    if (log.length > MAX_LOG_LINES) log.shift();
    console.log(`[csv-heal] ${text}`);
  };
  let spotifyRetryAt: string | null = null;
  const save = (extra: Partial<HealProgress>) => writeProgress({
    running: true, phase: null, current: 0, total: 0, healedSoFar: 0,
    startedAt: null, finishedAt: null, spotifyRetryAt, log: [...log], ...extra,
  });
  // Checked between rows in every pass — cancelHeal() (e.g. switching the
  // active playlist mid-sweep) throws HEAL_CANCELLED, caught once in
  // doHeal() so every in-progress loop unwinds without writing anything
  // further. cancelHeal() already resets the progress file itself.
  const checkCancelled = () => { if (cancelRequested) throw HEAL_CANCELLED; };

  if (gaps.length === 0 && uriGaps.length === 0) {
    addLog(`${checked} tracks checked — nothing missing`);
    await writeProgress({ running: false, phase: null, current: 0, total: 0, healedSoFar: 0, startedAt: null, finishedAt: new Date().toISOString(), spotifyRetryAt: null, log });
    return { checked, healed: 0, incomplete: 0 };
  }

  addLog(`${gaps.length + uriGaps.length}/${checked} tracks missing data — starting`);
  const startedAt = new Date().toISOString();

  // Write whatever's changed back into `lines` and flush to disk — called
  // after each phase so a restart mid-sweep (e.g. a redeploy) only loses
  // whatever hadn't been fetched yet, not the whole sweep's progress. Also
  // covers uriGaps, so a newly-found URI survives a restart even before it
  // reaches the later duration/feature/genre passes.
  const flush = async (): Promise<number> => {
    let healedNow = 0;
    for (const g of [...gaps, ...uriGaps]) {
      const rebuilt = g.row.map(csvEscape).join(",");
      if (rebuilt !== lines[g.line]) {
        lines[g.line] = rebuilt;
        healedNow++;
      }
    }
    if (healedNow > 0) await writeFile(csvPath, lines.join("\n"), "utf8");
    return healedNow;
  };

  // URIs first: a row with no Track URI is invisible to every other pass
  // (they all key off the Spotify ID). Search Spotify by name + artist and,
  // on a match, promote the row into `gaps` so the same sweep can still
  // fill its duration/features/genres afterward. Deliberately slow/serial
  // (one request at a time, generous gap) and checks the 429 sentinel
  // before every call — search is a heavier-weight endpoint than the
  // per-track lookup, so this is throttled more conservatively than the
  // duration pass below.
  let uriToken: string | null | undefined = undefined;
  let urisHealed = 0;
  if (uriGaps.length > 0) {
    addLog(`checking ${uriGaps.length} tracks with no Spotify URI (search)…`);
    await save({ phase: "uris", current: 0, total: uriGaps.length, healedSoFar: 0, startedAt });
    for (let i = 0; i < uriGaps.length; i++) {
      checkCancelled();
      const g = uriGaps[i];
      if (uriToken === null) break; // long rate limit hit earlier — stop searching for the rest of this sweep
      if (uriToken === undefined) uriToken = await spotifyAppToken();
      if (!uriToken) break; // no client-credentials configured
      const result = await spotifySearchUri(g.name, g.artist, uriToken);
      if (isRateLimited(result)) {
        uriToken = null;
        spotifyRetryAt = result.retryAt;
        addLog(`Spotify rate-limited during URI search — pausing until ${new Date(result.retryAt).toLocaleTimeString()}, ${uriGaps.length - i} tracks left unsearched this sweep`);
        break;
      }
      if (result) {
        g.row[idxUri] = result;
        const id = result.split(":").pop()!;
        // Promote into the normal gap list so duration/features/genres for
        // this newly-found track get a chance in this same sweep.
        gaps.push({
          line: g.line, row: g.row, id, name: g.name, artist: g.artist,
          needsDuration: idxDuration !== -1 && isBlank(g.row[idxDuration]),
          needsFeatures: FEATURE_COLS.some(([h]) => { const idx = col(h); return idx !== -1 && isBlank(g.row[idx]); }),
          needsGenres: idxGenres !== -1 && isBlank(g.row[idxGenres]),
        });
        urisHealed++;
      }
      await sleep(400); // conservative — search is heavier than the per-track lookup
      if ((i + 1) % 10 === 0 || i === uriGaps.length - 1) {
        addLog(`URIs: ${i + 1}/${uriGaps.length} checked, ${urisHealed} found`);
        await save({ phase: "uris", current: i + 1, total: uriGaps.length, healedSoFar: urisHealed, startedAt });
      }
    }
  }
  await flush();

  // Audio features via ReccoBeats (+ Deezer-ISRC fallback) first: one
  // batched call covers the whole gap list (fast), and Tempo/Energy is what
  // the dashboard actually requires to load a library at all — Duration
  // below is comparatively slow (sequential, one request per row) and
  // doesn't block anything the app needs immediately.
  const featureGaps = gaps.filter(g => g.needsFeatures);
  if (featureGaps.length > 0) {
    addLog(`checking ${featureGaps.length} tracks for missing BPM/audio features (ReccoBeats + Deezer)…`);
    await save({ phase: "features", current: 0, total: featureGaps.length, healedSoFar: urisHealed, startedAt });
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
      addLog(`feature lookup failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  let healed = await flush();
  const featuresHealed = healed;
  addLog(`audio features: filled ${featuresHealed} row${featuresHealed === 1 ? "" : "s"}`);
  await save({ phase: "duration", current: 0, total: gaps.filter(g => g.needsDuration).length, healedSoFar: urisHealed + featuresHealed, startedAt });

  // Durations: Spotify singles first (until/unless it 429s for a long
  // wait), Deezer for whatever's left, then Last.fm. Slow (sequential, ~1
  // request/row) — flushed incrementally every 25 rows so a restart
  // doesn't lose an hour of progress on a large library, with a progress
  // line every 50 rows.
  let token: string | null | undefined = undefined; // lazy — only fetch if needed
  const durationGaps = gaps.filter(g => g.needsDuration);
  let durationHealed = 0;
  if (durationGaps.length > 0) addLog(`checking ${durationGaps.length} tracks for missing durations (Spotify → Deezer → Last.fm)…`);
  for (let i = 0; i < durationGaps.length; i++) {
    checkCancelled();
    const g = durationGaps[i];
    let ms: number | null = null;
    if (token !== null) {
      if (token === undefined) token = await spotifyAppToken();
      if (token) {
        const result = await spotifyDurationMs(g.id, token);
        if (isRateLimited(result)) {
          token = null; // stop using Spotify for the rest of this sweep
          spotifyRetryAt = result.retryAt;
          addLog(`Spotify rate-limited — pausing Spotify lookups until ${new Date(result.retryAt).toLocaleTimeString()}, continuing with Deezer/Last.fm only`);
        } else {
          ms = result;
        }
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
      addLog(`durations: ${i + 1}/${durationGaps.length} checked, ${durationHealed} filled`);
      await save({ phase: "duration", current: i + 1, total: durationGaps.length, healedSoFar: urisHealed + featuresHealed + durationHealed, startedAt });
    }
  }
  const durationFlushHealed = await flush();
  healed = urisHealed + featuresHealed + durationFlushHealed;

  // Genres: Deezer only — Spotify's artist endpoint no longer returns
  // genre data for this app (confirmed 200 OK with no `genres` field), so
  // there's no Spotify pass to attempt here at all.
  const genreGaps = gaps.filter(g => g.needsGenres && g.name && g.artist);
  let genresHealed = 0;
  if (genreGaps.length > 0) {
    addLog(`checking ${genreGaps.length} tracks for missing genres (Deezer)…`);
    await save({ phase: "genres", current: 0, total: genreGaps.length, healedSoFar: healed, startedAt });
    for (let i = 0; i < genreGaps.length; i++) {
      checkCancelled();
      const g = genreGaps[i];
      try {
        const genres = await deezerGenres(g.name, g.artist);
        if (genres && idxGenres !== -1 && isBlank(g.row[idxGenres])) {
          g.row[idxGenres] = genres;
          g.needsGenres = false;
          genresHealed++;
        }
      } catch { /* skip this track */ }
      await sleep(150);
      if ((i + 1) % 25 === 0) await flush();
      if ((i + 1) % 50 === 0 || i === genreGaps.length - 1) {
        addLog(`genres: ${i + 1}/${genreGaps.length} checked, ${genresHealed} filled`);
        await save({ phase: "genres", current: i + 1, total: genreGaps.length, healedSoFar: healed + genresHealed, startedAt });
      }
    }
  }
  const genreFlushHealed = await flush();
  healed += genreFlushHealed;

  const stillNoUri = uriGaps.length - urisHealed;
  const incomplete = gaps.filter(g => g.needsDuration || g.needsFeatures || g.needsGenres).length + stillNoUri;
  addLog(`done — healed ${healed} row${healed === 1 ? "" : "s"}${incomplete ? `, ${incomplete} still incomplete` : ""}`);
  await writeProgress({
    running: false, phase: null, current: durationGaps.length, total: durationGaps.length,
    healedSoFar: healed, startedAt, finishedAt: new Date().toISOString(), spotifyRetryAt, log,
  });
  return { checked, healed, incomplete };
}
