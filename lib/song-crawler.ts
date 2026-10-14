import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { readAllTracks } from "@/lib/tracks-store";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { resolveByIsrc } from "@/lib/track-enrich";
import { addTracksToLibrary } from "@/lib/library-add";
import { healActiveCsv } from "@/lib/csv-heal";
import { cronNotify } from "@/lib/cron-notify";

// Song Crawler as a server-side background job (Settings > Tracklist).
// Starting from an artist it walks Deezer "artist radio" breadth-first —
// optionally checking the artist's whole catalogue first — BPM-checks every
// track, and adds matches to the library (Spotify URI via ISRC/ReccoBeats,
// never Spotify's Search API). The job runs independently of any browser:
// the page polls its numbered log, Stop is a request, and closing the page
// changes nothing. State is saved to disk so the last crawl's log survives a
// reload; a server restart ends a running crawl (reported as interrupted).

const DOUBLETIME_THRESHOLD = 95; // mirrors MixPaceChart / replace-candidates
const BPM_TOLERANCE = 1;
export const DEFAULT_MAX_ARTISTS = 50;
export const MAX_ARTISTS_CAP = 2000;
const RADIO_LIMIT = 25;
const DEEZER_GAP_MS = 150; // Deezer allows 50 req/5s; stay well under
const LOG_KEEP = 5000;
const STATE_PATH = path.join(process.cwd(), "song-crawler-state.json");

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const effective = (bpm: number) => (bpm < DOUBLETIME_THRESHOLD ? bpm * 2 : bpm);

interface DeezerRadioTrack { id: number; title: string; artist: { id: number; name: string } }
interface DeezerAlbumTrack extends DeezerRadioTrack { isrc?: string; duration?: number }

export type CrawlLevel = "info" | "match" | "warn" | "error";
export interface CrawlLine { seq: number; at: string; level: CrawlLevel; msg: string }
export type CrawlStatus = "running" | "stopping" | "healing" | "done" | "stopped" | "error" | "interrupted";

// What to crawl: the typed artist's own catalogue, their artist radio
// (spreading to the artists it finds), or the catalogue first then radio.
export type CrawlMode = "artist" | "radio" | "both";

export interface CrawlParams {
  artist: string;
  bpm?: number;
  bpmMin?: number;
  bpmMax?: number;
  maxArtists?: number;
  mode?: CrawlMode;
}

export interface CrawlJob {
  id: string;
  params: CrawlParams;
  status: CrawlStatus;
  startedAt: string;
  finishedAt: string | null;
  added: number;
  crawled: number;      // artists whose radio has been processed
  totalArtists: number; // distinct artists found so far (seed included)
  nextSeq: number;
  log: CrawlLine[];
}

// Survives Next.js module re-evaluation within the one server process.
const g = globalThis as unknown as { __songCrawler?: { job: CrawlJob | null; stopRequested: boolean; loaded: boolean; lastSave: number } };
const store = (g.__songCrawler ??= { job: null, stopRequested: false, loaded: false, lastSave: 0 });

function persist(force = false) {
  if (!store.job) return;
  const now = Date.now();
  if (!force && now - store.lastSave < 3000) return;
  store.lastSave = now;
  try { writeFileSync(STATE_PATH, JSON.stringify(store.job), "utf8"); } catch { /* best-effort */ }
}

// First access after a (re)start: restore the last crawl from disk. One that
// was still running when the process died can't be resumed — mark it.
function load() {
  if (store.loaded) return;
  store.loaded = true;
  try {
    const saved = JSON.parse(readFileSync(STATE_PATH, "utf8")) as CrawlJob;
    if (["running", "stopping", "healing"].includes(saved.status)) {
      saved.status = "interrupted";
      saved.finishedAt = saved.finishedAt ?? new Date().toISOString();
      saved.log.push({ seq: saved.nextSeq++, at: new Date().toISOString(), level: "error", msg: "Crawl interrupted — the server restarted (e.g. a deploy). Start it again to continue." });
    }
    store.job = saved;
    persist(true);
  } catch { /* no saved crawl yet */ }
}

function log(msg: string, level: CrawlLevel = "info") {
  const job = store.job;
  if (!job) return;
  job.log.push({ seq: job.nextSeq++, at: new Date().toISOString(), level, msg });
  if (job.log.length > LOG_KEEP) job.log.splice(0, job.log.length - LOG_KEEP);
  persist();
}

export function getCrawl(sinceSeq = 0): { job: Omit<CrawlJob, "log"> | null; lines: CrawlLine[] } {
  load();
  const job = store.job;
  if (!job) return { job: null, lines: [] };
  const { log: lines, ...meta } = job;
  return { job: meta, lines: lines.filter(l => l.seq >= sinceSeq) };
}

export function isCrawlRunning(): boolean {
  load();
  return !!store.job && ["running", "stopping", "healing"].includes(store.job.status);
}

export function requestStopCrawl(): boolean {
  if (!isCrawlRunning() || store.job!.status !== "running") return false;
  store.stopRequested = true;
  store.job!.status = "stopping";
  log("Stop requested — finishing the current track, then filling in missing data…", "warn");
  return true;
}

export function startCrawl(params: CrawlParams): { ok: true; id: string } | { ok: false; error: string } {
  load();
  if (isCrawlRunning()) return { ok: false, error: "A crawl is already running — stop it first." };
  const isRange = !!params.bpmMin && !!params.bpmMax && params.bpmMin > 0 && params.bpmMax >= params.bpmMin;
  if (!params.artist?.trim() || (!isRange && !(params.bpm && params.bpm > 0))) {
    return { ok: false, error: "artist and a bpm (or bpmMin/bpmMax range) required" };
  }
  store.stopRequested = false;
  store.job = {
    id: randomUUID(), params, status: "running",
    startedAt: new Date().toISOString(), finishedAt: null,
    added: 0, crawled: 0, totalArtists: 0, nextSeq: 0, log: [],
  };
  persist(true);
  void runCrawl(store.job).catch(e => {
    if (store.job) { store.job.status = "error"; store.job.finishedAt = new Date().toISOString(); }
    log(`Crawl failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    persist(true);
  });
  return { ok: true, id: store.job.id };
}

async function runCrawl(job: CrawlJob) {
  const p = job.params;
  const maxArtists = Math.min(Math.max(Math.round(Number(p.maxArtists) || DEFAULT_MAX_ARTISTS), 1), MAX_ARTISTS_CAP);
  const isRange = !!p.bpmMin && !!p.bpmMax && p.bpmMin > 0 && p.bpmMax >= p.bpmMin;
  const lo = isRange ? effective(p.bpmMin!) : effective(p.bpm!) - BPM_TOLERANCE;
  const hi = isRange ? effective(p.bpmMax!) : effective(p.bpm!) + BPM_TOLERANCE;
  const targetLabel = isRange ? `${Math.round(lo)}–${Math.round(hi)} BPM` : `${Math.round(effective(p.bpm!))} BPM (±${BPM_TOLERANCE})`;
  const stopped = () => store.stopRequested;
  const artist = p.artist.trim();
  const mode: CrawlMode = p.mode === "artist" || p.mode === "both" ? p.mode : "radio";
  const doCatalogue = mode !== "radio";
  const doRadio = mode !== "artist";
  const scope = mode === "artist" ? `${artist}'s own tracks only`
    : mode === "both" ? `${artist}'s own tracks, then artist radio (up to ${maxArtists} artists)`
    : `artist radio from ${artist} (up to ${maxArtists} artists)`;

  log(`Crawling ${scope} for ${targetLabel} — half-time tracks counted at double tempo`);

  const library = readAllTracks(loadRunningPlaylistConfig().csvFile);
  const knownUris = new Set(library.map(t => t.uri).filter(Boolean));
  const knownIsrcs = new Set(library.map(t => t.isrc).filter((x): x is string => !!x));

  const deezer = async <T,>(apiPath: string): Promise<T | null> => {
    await sleep(DEEZER_GAP_MS);
    try {
      const res = await fetch(`https://api.deezer.com${apiPath}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const data = await res.json() as T & { error?: unknown };
      return data.error ? null : data;
    } catch {
      return null; // a single flaky call shouldn't end an hours-long crawl
    }
  };

  // Seed: exact (case-insensitive) artist-name match, same rule as
  // lib/deezer-artist-top.ts so "Hybrid" never becomes "Hybrid Minds".
  const found = await deezer<{ data?: { id: number; name: string }[] }>(`/search/artist?q=${encodeURIComponent(artist)}&limit=25`);
  const seed = found?.data?.find(a => a.name.trim().toLowerCase() === artist.toLowerCase());
  if (!seed) {
    log(`No exact Deezer artist match for "${artist}"`, "warn");
    return finish(job, "done");
  }
  job.totalArtists = 1;

  const seenTracks = new Set<number>();
  const checkedIsrcs = new Set<string>();

  // BPM-checks one Deezer track and, on a match, adds it to the library.
  const checkTrack = async (t: DeezerRadioTrack, isrcHint?: string | null, durationHintSec?: number | null) => {
    if (seenTracks.has(t.id)) return;
    seenTracks.add(t.id);
    // The same recording appears on album, single and deluxe releases.
    if (isrcHint) {
      if (checkedIsrcs.has(isrcHint)) return;
      checkedIsrcs.add(isrcHint);
    }
    const label = `${t.title} — ${t.artist.name}`;
    if (isrcHint && knownIsrcs.has(isrcHint)) { log(`  ${label}: already in library`); return; }
    const detail = await deezer<{ bpm?: number; isrc?: string; duration?: number }>(`/track/${t.id}`);
    // Deezer gives length in seconds — saved so the track never lands
    // in the library with a blank duration.
    const durationSec = detail?.duration && detail.duration > 0 ? detail.duration : durationHintSec ?? null;
    const isrc = detail?.isrc ?? isrcHint ?? null;
    if (isrc && !isrcHint) {
      if (checkedIsrcs.has(isrc)) return;
      checkedIsrcs.add(isrc);
    }
    if (isrc && knownIsrcs.has(isrc)) { log(`  ${label}: already in library`); return; }

    // Deezer's bpm is 0 when unknown — fall back to ReccoBeats' tempo.
    let tempo = detail?.bpm && detail.bpm > 0 ? detail.bpm : null;
    let resolved: Awaited<ReturnType<typeof resolveByIsrc>> = null;
    if (tempo == null && isrc) {
      resolved = await resolveByIsrc(isrc).catch(() => null);
      tempo = resolved?.tempo ?? null;
    }
    if (tempo == null) { log(`  ${label}: no BPM available`); return; }

    const eff = effective(tempo);
    if (!(eff >= lo && eff <= hi)) { log(`  ${label}: ${Math.round(tempo)} BPM`); return; }

    if (!isrc) { log(`  ${label}: ${Math.round(tempo)} BPM matches, but no ISRC to resolve on Spotify`, "warn"); return; }
    if (!resolved) resolved = await resolveByIsrc(isrc).catch(() => null);
    if (!resolved) { log(`  ${label}: ${Math.round(tempo)} BPM matches, but couldn't resolve a Spotify track`, "warn"); return; }
    if (knownUris.has(resolved.uri)) { log(`  ${label}: already in library`); return; }

    const result = await addTracksToLibrary([{
      uri: resolved.uri, name: t.title, artist: t.artist.name, tempo: resolved.tempo ?? tempo,
      key: resolved.key, mode: resolved.mode, energy: resolved.energy,
      danceability: resolved.danceability, valence: resolved.valence,
      ...(durationSec ? { durationMs: durationSec * 1000 } : {}),
    }]);
    knownUris.add(resolved.uri);
    knownIsrcs.add(isrc);
    if (result.added > 0) {
      job.added++;
      log(`  ✓ ADDED ${label} (${Math.round(tempo)} BPM)`, "match");
    } else {
      log(`  ${label}: matches, but was previously deleted from the library — skipped`, "warn");
    }
  };

  // Optional catalogue pass: every track credited to the seed artist across
  // all their releases, before any radio. Tracks credited to someone else
  // (side projects, guest-led tracks) are skipped.
  if (doCatalogue && !stopped()) {
    const albums: { id: number; title: string }[] = [];
    let next: string | null = `/artist/${seed.id}/albums?limit=100`;
    while (next && !stopped()) {
      const page: { data?: { id: number; title: string }[]; next?: string } | null = await deezer(next);
      albums.push(...(page?.data ?? []));
      next = page?.next ? page.next.replace("https://api.deezer.com", "") : null;
    }
    log(`All tracks by ${seed.name}: ${albums.length} release${albums.length === 1 ? "" : "s"} to check`);
    for (let i = 0; i < albums.length; i++) {
      if (stopped()) break;
      const album = albums[i];
      const tracks = await deezer<{ data?: DeezerAlbumTrack[] }>(`/album/${album.id}/tracks?limit=200`);
      const own = (tracks?.data ?? []).filter(t => t.artist?.id === seed.id);
      log(`[release ${i + 1}/${albums.length}] ${album.title} (${own.length} track${own.length === 1 ? "" : "s"})`);
      for (const t of own) {
        if (stopped()) break;
        await checkTrack(t, t.isrc ?? null, t.duration ?? null);
      }
    }
    if (!stopped()) log(doRadio ? `Finished ${seed.name}'s catalogue — starting artist radio.` : `Finished ${seed.name}'s catalogue.`);
  }

  const queue: { id: number; name: string }[] = [seed];
  const queuedArtists = new Set<number>([seed.id]);
  while (doRadio && queue.length > 0 && !stopped()) {
    const current = queue.shift()!;
    job.crawled++;
    log(`[${job.crawled}/${queuedArtists.size}] Artist radio: ${current.name} (${queue.length} still queued)`);
    const radio = await deezer<{ data?: DeezerRadioTrack[] }>(`/artist/${current.id}/radio?limit=${RADIO_LIMIT}`);
    if (!radio?.data?.length) { log(`  no radio for ${current.name}`, "warn"); continue; }
    for (const t of radio.data) {
      if (stopped()) break;
      if (!queuedArtists.has(t.artist.id) && queuedArtists.size < maxArtists) {
        queuedArtists.add(t.artist.id);
        job.totalArtists = queuedArtists.size;
        if (queuedArtists.size === maxArtists) {
          log(`Reached ${maxArtists} artists — no more will be added; finishing the ${queue.length + 1} still queued.`, "warn");
        }
        queue.push({ id: t.artist.id, name: t.artist.name });
      }
      await checkTrack(t);
    }
  }

  const n = `${job.added} track${job.added === 1 ? "" : "s"} added`;
  if (stopped()) log(`Stopped by you. ${n}.`, "warn");
  else if (doRadio) log(`Crawl complete — no more artists to visit. ${n}.`);
  else log(`Crawl complete. ${n}.`);
  return finish(job, stopped() ? "stopped" : "done");
}

// Post-crawl fill-in (logged), then the final status + a notification —
// the crawl may have run for hours with nobody watching the page.
async function finish(job: CrawlJob, outcome: "done" | "stopped") {
  if (job.added > 0) {
    job.status = "healing";
    log("Post-crawl: filling in missing data (Spotify links, audio features, durations, genres)…");
    const t0 = Date.now();
    try {
      const heal = await healActiveCsv();
      log(
        `Post-crawl: fill-in done in ${Math.round((Date.now() - t0) / 1000)}s — ${heal.healed} row${heal.healed === 1 ? "" : "s"} updated, ` +
        `${heal.incomplete} still incomplete across the library` +
        (heal.spotifyRetryAt ? ` (Spotify rate-limited until ${new Date(heal.spotifyRetryAt).toLocaleTimeString("en-GB")}, used Deezer/Last.fm)` : ""),
        heal.incomplete > 0 ? "warn" : "info",
      );
    } catch (e) {
      log(`Post-crawl fill-in failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }
  job.status = outcome;
  job.finishedAt = new Date().toISOString();
  persist(true);

  const p = job.params;
  const bpm = p.bpmMin && p.bpmMax ? `${p.bpmMin}–${p.bpmMax}` : `${p.bpm}`;
  const mins = Math.round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 60000);
  const scopeNote = p.mode === "artist" ? "artist's own tracks" : `artist ${job.crawled} of ${job.totalArtists}`;
  await cronNotify(
    `${p.artist} · ${bpm} BPM — ${job.added} track${job.added === 1 ? "" : "s"} added, ${scopeNote}, ~${mins} min.`,
    {
      title: outcome === "stopped" ? "🕸 Song Crawler stopped" : "🕸 Song Crawler finished",
      tags: "spider_web",
      type: "song-crawler",
      priority: job.added > 0 ? "default" : "low",
    },
  ).catch(() => {});
}
