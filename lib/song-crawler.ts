import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { readAllTracks } from "@/lib/tracks-store";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { resolveByIsrc } from "@/lib/track-enrich";
import { addTracksToLibrary } from "@/lib/library-add";
import { healActiveCsv } from "@/lib/csv-heal";
import { cronNotify } from "@/lib/cron-notify";
import { parseBpmSpec, type BpmSpecResult } from "@/lib/bpm-spec";
import { splitArtistList } from "@/lib/artist-list";
import { recordCrawledArtist } from "@/lib/crawled-artists";
import { ensureReviewSyncStarted, reviewPlaylistUri, scheduleReviewSync } from "@/lib/review-playlist";
import { getLookupToken } from "@/lib/spotify-lookup-account";
import { getSpotifyBlockedUntil, setSpotifyBlockedUntil, parseRetryAfter, recordSpotifyRequest } from "@/lib/spotify-rate-limit";

// Song Crawler as a server-side background job (Settings > Tracklist).
// Starting from an artist it walks Deezer "artist radio" breadth-first —
// optionally checking the artist's whole catalogue first — BPM-checks every
// track, and adds matches to the library (Spotify URI via ISRC/ReccoBeats,
// never Spotify's Search API). The job runs independently of any browser:
// the page polls its numbered log, Stop is a request, and closing the page
// changes nothing. State is saved to disk so the last crawl's log survives a
// reload; a server restart ends a running crawl (reported as interrupted).

const DOUBLETIME_THRESHOLD = 95; // mirrors MixPaceChart / replace-candidates
export const DEFAULT_MAX_ARTISTS = 50;
export const MAX_ARTISTS_CAP = 2000;
const RADIO_LIMIT = 25;
const TOP_TRACKS_LIMIT = 25;
const RELATED_LIMIT = 20;
const DEEZER_GAP_MS = 150; // Deezer allows 50 req/5s; stay well under
const LOG_KEEP = 5000;
const STATE_PATH = path.join(process.cwd(), "song-crawler-state.json");

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const effective = (bpm: number) => (bpm < DOUBLETIME_THRESHOLD ? bpm * 2 : bpm);
// Whole-number effective BPM — what the tracklist filter, mixer and Replace
// by BPM compare on (82.9 BPM doubles to 165.8 -> 166).
const effRounded = (bpm: number) => Math.round(effective(bpm));
// "83 BPM" / "83 BPM (×2 = 166)" for the log.
const bpmLabel = (bpm: number) => (bpm < DOUBLETIME_THRESHOLD ? `${Math.round(bpm)} BPM (×2 = ${effRounded(bpm)})` : `${Math.round(bpm)} BPM`);

interface DeezerRadioTrack { id: number; title: string; artist: { id: number; name: string } }
interface DeezerAlbumTrack extends DeezerRadioTrack { isrc?: string; duration?: number }

interface LinkTrack { id: string; uri: string; name: string; artist: string; durationMs: number | null }

// open.spotify.com/album/<id> or /playlist/<id> (any ?si=… is ignored), or
// spotify:album:<id> / spotify:playlist:<id>.
export function parseSpotifyLink(link: string | undefined): { kind: "album" | "playlist" | "artist"; id: string } | null {
  if (!link) return null;
  const m = link.trim().match(/(?:open\.spotify\.com\/(?:intl-[a-z]+\/)?|spotify:)(album|playlist|artist)[/:]([A-Za-z0-9]{10,})/);
  return m ? { kind: m[1] as "album" | "playlist" | "artist", id: m[2] } : null;
}

// An artist link names one specific artist. Spotify and Deezer artist ids
// don't map to each other, and several Deezer artists can share a name, so
// the link's artist is read from Spotify's public embed page (no login) —
// name plus top-track titles — and the matching Deezer artist is picked by
// those titles (see findArtist in runCrawl). oEmbed gives just the name if
// the embed page can't be read.
async function fetchSpotifyArtist(id: string): Promise<{ name: string; topTitles: string[] } | null> {
  try {
    const res = await fetch(`https://open.spotify.com/embed/artist/${id}`, {
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36" },
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (m) {
        const data = JSON.parse(m[1]) as { props?: { pageProps?: { state?: { data?: { entity?: {
          name?: string; title?: string; trackList?: { title?: string }[];
        } } } } } };
        const entity = data.props?.pageProps?.state?.data?.entity;
        const name = (entity?.name ?? entity?.title)?.trim();
        if (name) return { name, topTitles: (entity?.trackList ?? []).map(t => t.title ?? "").filter(Boolean) };
      }
    }
  } catch { /* fall through to oEmbed */ }
  try {
    const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/artist/${id}`)}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const d = await res.json() as { title?: string };
    return d.title?.trim() ? { name: d.title.trim(), topTitles: [] } : null;
  } catch {
    return null;
  }
}

// Fallback for playlists the Spotify API won't list: Spotify's public embed
// player page carries the track list (first 100 tracks) in its page data —
// no login needed. Spotify only lets this app list the tracks of playlists
// the logged-in user owns (others return 403 / no tracks).
async function fetchEmbedTracks(kind: "album" | "playlist", id: string): Promise<{ name: string; tracks: LinkTrack[]; capped: boolean } | { error: string }> {
  try {
    const res = await fetch(`https://open.spotify.com/embed/${kind}/${id}`, {
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { error: `embed page ${res.status}` };
    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) return { error: "embed page had no track data" };
    const data = JSON.parse(m[1]) as { props?: { pageProps?: { state?: { data?: { entity?: {
      name?: string; title?: string;
      trackList?: { uri?: string; title?: string; subtitle?: string; duration?: number }[];
    } } } } } };
    const entity = data.props?.pageProps?.state?.data?.entity;
    const list = entity?.trackList ?? [];
    const tracks: LinkTrack[] = list
      .filter(t => t.uri?.startsWith("spotify:track:"))
      .map(t => ({ id: t.uri!.split(":")[2], uri: t.uri!, name: t.title ?? "", artist: t.subtitle ?? "", durationMs: t.duration ?? null }));
    return { name: entity?.name ?? entity?.title ?? (kind === "album" ? "Album" : "Playlist"), tracks, capped: list.length >= 100 };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// Reads an album's / playlist's tracks with the stored Spotify login —
// plain album/playlist reads, never Spotify Search. Falls back to the
// public embed page when Spotify refuses (another user's playlist).
async function fetchLinkTracks(kind: "album" | "playlist", id: string): Promise<{ name: string; tracks: LinkTrack[]; via?: string } | { error: string }> {
  const viaApi = await fetchLinkTracksApi(kind, id);
  if (!("error" in viaApi) && viaApi.tracks.length > 0) return viaApi;
  const embed = await fetchEmbedTracks(kind, id);
  if ("error" in embed) return "error" in viaApi ? { error: `${viaApi.error}; embed fallback: ${embed.error}` } : { error: embed.error };
  return {
    name: embed.name,
    tracks: embed.tracks,
    via: `Spotify wouldn't list this ${kind}'s tracks (${"error" in viaApi ? viaApi.error : "no tracks returned"} — it only allows playlists you own), so they were read from Spotify's public player page${embed.capped ? " — the first 100 tracks only" : ""}`,
  };
}

async function fetchLinkTracksApi(kind: "album" | "playlist", id: string): Promise<{ name: string; tracks: LinkTrack[] } | { error: string }> {
  // A lookup: uses the secondary lookup account (never the main account / app) and its own rate-limit marker.
  const blocked = await getSpotifyBlockedUntil("search");
  if (blocked) return { error: `Spotify lookups are rate-limited until ${blocked}` };
  const token = await getLookupToken();
  if (!token.ok) return { error: token.reason };
  const get = async (url: string) => {
    await sleep(300);
    recordSpotifyRequest();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token.token}` }, signal: AbortSignal.timeout(20000) });
    if (res.status === 429) {
      const wait = Math.min(parseRetryAfter(res.headers.get("Retry-After") ?? "30"), 24 * 3600);
      await setSpotifyBlockedUntil(new Date(Date.now() + wait * 1000 + 30_000).toISOString(), "search");
      throw new Error("Spotify 429");
    }
    if (!res.ok) throw new Error(`Spotify ${res.status}`);
    return res.json();
  };
  try {
    type SpTrack = { id?: string | null; uri?: string; name?: string; duration_ms?: number; artists?: { name: string }[]; is_local?: boolean };
    const toTrack = (t: SpTrack | null | undefined): LinkTrack | null =>
      t?.id && t.uri?.startsWith("spotify:track:") && !t.is_local
        ? { id: t.id, uri: t.uri, name: t.name ?? "", artist: (t.artists ?? []).map(a => a.name).join(", "), durationMs: t.duration_ms ?? null }
        : null;
    const tracks: LinkTrack[] = [];
    let name = "";
    if (kind === "album") {
      const album = await get(`https://api.spotify.com/v1/albums/${id}`) as { name?: string; tracks?: { items?: SpTrack[]; next?: string | null } };
      name = album.name ?? "Album";
      for (const t of album.tracks?.items ?? []) { const x = toTrack(t); if (x) tracks.push(x); }
      let next = album.tracks?.next ?? null;
      while (next) {
        const page = await get(next) as { items?: SpTrack[]; next?: string | null };
        for (const t of page.items ?? []) { const x = toTrack(t); if (x) tracks.push(x); }
        next = page.next ?? null;
      }
    } else {
      const pl = await get(`https://api.spotify.com/v1/playlists/${id}?fields=name`) as { name?: string };
      name = pl.name ?? "Playlist";
      let next: string | null = `https://api.spotify.com/v1/playlists/${id}/items?limit=100&fields=next,items(track(id,uri,name,duration_ms,is_local,artists(name)))`;
      while (next) {
        const page = await get(next) as { items?: { track?: SpTrack | null }[]; next?: string | null };
        for (const it of page.items ?? []) { const x = toTrack(it.track); if (x) tracks.push(x); }
        next = page.next ?? null;
      }
    }
    return { name, tracks };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export type CrawlLevel = "info" | "match" | "warn" | "error";
export interface CrawlLine { seq: number; at: string; level: CrawlLevel; msg: string }
export type CrawlStatus = "running" | "paused" | "stopping" | "healing" | "done" | "stopped" | "error" | "interrupted";

// What to crawl — any combination of:
//   artist:  the typed artist's own catalogue (every album, EP and single)
//   radio:   each visited artist's radio tracks; artists in it are queued
//   related: each visited artist's related artists are queued, and every
//            visited artist's top tracks are checked
// radio + related share one artist queue and the Max artists cap.
export interface CrawlSources { artist: boolean; radio: boolean; related: boolean }
/** @deprecated older clients — mapped onto sources. */
export type CrawlMode = "artist" | "radio" | "both";

function resolveSources(p: CrawlParams): CrawlSources {
  if (p.sources && (p.sources.artist || p.sources.radio || p.sources.related)) {
    return { artist: !!p.sources.artist, radio: !!p.sources.radio, related: !!p.sources.related };
  }
  if (p.mode === "artist") return { artist: true, radio: false, related: false };
  if (p.mode === "both") return { artist: true, radio: true, related: false };
  return { artist: false, radio: true, related: false };
}

export interface CrawlParams {
  artist: string;
  /** open.spotify.com artist link (crawls that artist), or album / playlist
      link — its tracks are BPM-checked
      directly, and its artists join the typed artist as starting points
      for radio / related. */
  link?: string;
  /** "120-122", "121,145,167" or a mix — see lib/bpm-spec.ts. Supersedes
      bpm / bpmMin+bpmMax, which older clients (the Android app) still send. */
  bpmSpec?: string;
  bpm?: number;
  bpmMin?: number;
  bpmMax?: number;
  maxArtists?: number;
  /** Pause once this many songs are awaiting review; resume when the
      review list drops below it. Empty/0 = no limit. Can be changed while
      the crawl runs (setCrawlReviewLimit). */
  reviewLimit?: number | null;
  sources?: Partial<CrawlSources>;
  mode?: CrawlMode;
}

// Where the crawl had got to, saved as it goes, so a crawl that was interrupted (the server
// restarted, it crashed) or stopped can carry on from there instead of starting again: at the
// release being checked, the artist being visited (with the artists still queued), or the batch of
// album / playlist tracks. Tracks already added are in the library and are skipped on the way.
export interface CrawlCheckpoint {
  stage: "seeds" | "catalogue" | "spread" | "linkTracks" | "linkSpread";
  seeds: { id: number; name: string }[];
  seedIndex: number;
  album: number;      // catalogue: the release being checked
  linkBatch: number;  // link tracks: the batch of 40 being checked
  queue: { id: number; name: string }[]; // spread: artists still to visit, the one being visited first
  queued: number[];
  crawlBase: number;
  skipTopFor: number[];
}

const freshCheckpoint = (): CrawlCheckpoint => ({
  stage: "seeds", seeds: [], seedIndex: 0, album: 0, linkBatch: 0, queue: [], queued: [], crawlBase: 0, skipTopFor: [],
});

export interface CrawlJob {
  id: string;
  // Not sent to the page (it is large); `resumable` tells the page whether it can continue.
  checkpoint?: CrawlCheckpoint;
  // Why status is "paused": the review limit, or the user's own pause button.
  pauseReason?: "review" | "user";
  params: CrawlParams;
  status: CrawlStatus;
  startedAt: string;
  finishedAt: string | null;
  added: number;
  // Songs crawls have added that haven't been reviewed yet — carried over
  // from crawl to crawl until accepted or deleted (shown beside the log).
  addedTracks: { uri: string; name: string; artist: string; bpm: number }[];
  crawled: number;      // artists whose radio has been processed
  linkName?: string;    // album / playlist name, when crawling a link
  checked?: number;     // tracks checked this run (each distinct track looked at)
  totalArtists: number; // distinct artists found so far (seed included)
  nextSeq: number;
  log: CrawlLine[];
}

// Survives Next.js module re-evaluation within the one server process.
const g = globalThis as unknown as { __songCrawler?: { job: CrawlJob | null; stopRequested: boolean; loaded: boolean; lastSave: number; queue?: CrawlParams[]; userPaused?: boolean } };
const store = (g.__songCrawler ??= { job: null, stopRequested: false, loaded: false, lastSave: 0, queue: [] });
store.queue ??= [];
// Artists waiting for their own crawl (right-click > Lookup on a song under review). They run
// one after another once the crawl in progress finishes; kept on disk so a restart keeps them.
const QUEUE_PATH = path.join(process.cwd(), "song-crawler-queue.json");
function persistQueue() {
  try { writeFileSync(QUEUE_PATH, JSON.stringify(store.queue ?? []), "utf8"); } catch { /* best-effort */ }
}

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
  try { store.queue = JSON.parse(readFileSync(QUEUE_PATH, "utf8")) as CrawlParams[]; } catch { /* no queue saved */ }
  try {
    const saved = JSON.parse(readFileSync(STATE_PATH, "utf8")) as CrawlJob;
    if (["running", "paused", "stopping", "healing"].includes(saved.status)) {
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

// The review list in order, for the "PaceSync review" Spotify playlist to mirror.
function reviewUris(): string[] {
  load();
  return (store.job?.addedTracks ?? []).map(t => t.uri);
}

// The review playlist's Spotify URI once it exists and has been synced (null before
// that). The first call after a restart also kicks off a sync to rebuild its state.
export function getReviewPlaylistUri(): string | null {
  ensureReviewSyncStarted(reviewUris);
  return reviewPlaylistUri();
}

// A stopped / interrupted / failed crawl that saved where it got to can carry on from there.
function isResumable(job: CrawlJob | null): boolean {
  return !!job?.checkpoint && ["interrupted", "stopped", "error"].includes(job.status);
}

export function getCrawl(sinceSeq = 0): { job: (Omit<CrawlJob, "log" | "checkpoint"> & { resumable: boolean }) | null; lines: CrawlLine[] } {
  load();
  const job = store.job;
  if (!job) return { job: null, lines: [] };
  const { log: lines, checkpoint: _checkpoint, ...meta } = job;
  void _checkpoint;
  return { job: { ...meta, resumable: isResumable(job) }, lines: lines.filter(l => l.seq >= sinceSeq) };
}

// Drops a song from the crawl's added list and notes it in the log —
// either deleted from the library, or accepted (kept, just reviewed).
// reason "removed": taken out of the library and Spotify playlist but NOT
// put on the deleted list, so it can be added again later.
export function removeCrawlAddedTrack(uri: string, reason: "deleted" | "accepted" | "removed" = "deleted"): boolean {
  load();
  const job = store.job;
  if (!job?.addedTracks) return false;
  const i = job.addedTracks.findIndex(t => t.uri === uri);
  if (i < 0) return false;
  const [t] = job.addedTracks.splice(i, 1);
  if (reason === "accepted") log(`  ✓ Accepted ${t.name} — ${t.artist} (kept in the library)`);
  else if (reason === "removed") log(`  ↩ Removed ${t.name} — ${t.artist} from the library (can be re-added)`, "warn");
  else log(`  ✗ Deleted ${t.name} — ${t.artist} from the library`, "warn");
  persist(true);
  scheduleReviewSync(reviewUris);
  return true;
}

// Changes the running crawl's review limit (null/0 = none).
export function setCrawlReviewLimit(limit: number | null): boolean {
  load();
  if (!isCrawlRunning()) return false;
  const n = limit && limit > 0 ? Math.round(limit) : null;
  store.job!.params.reviewLimit = n;
  log(n ? `Review limit set to ${n}.` : "Review limit removed.");
  persist(true);
  return true;
}

export function isCrawlRunning(): boolean {
  load();
  return !!store.job && ["running", "paused", "stopping", "healing"].includes(store.job.status);
}

export function requestStopCrawl(): boolean {
  if (!isCrawlRunning() || (store.job!.status !== "running" && store.job!.status !== "paused")) return false;
  store.stopRequested = true;
  store.userPaused = false;
  store.job!.status = "stopping";
  if (store.queue!.length > 0) {
    log(`Cleared the ${store.queue!.length} queued artist${store.queue!.length === 1 ? "" : "s"}.`, "warn");
    store.queue = [];
    persistQueue();
  }
  log("Stop requested — finishing the current track, then filling in missing data…", "warn");
  return true;
}

// Pause button: the crawl holds at the next track (see waitIfPaused in runCrawl).
export function requestPauseCrawl(): boolean {
  load();
  if (!isCrawlRunning() || store.job!.status !== "running") return false;
  store.userPaused = true;
  log("Pause requested - the crawl will pause after the current track.", "warn");
  return true;
}

// Resume button: un-pauses a paused crawl, or carries on an interrupted / stopped one from the
// point it had reached.
export function resumeCrawl(): { ok: true; kind: "unpaused" | "restarted" } | { ok: false; error: string } {
  load();
  if (store.userPaused) { store.userPaused = false; return { ok: true, kind: "unpaused" }; }
  if (isCrawlRunning()) return { ok: false, error: "The crawl is already running." };
  const job = store.job;
  if (!job || !isResumable(job)) return { ok: false, error: "There is no interrupted crawl to resume." };
  store.stopRequested = false;
  store.userPaused = false;
  job.status = "running";
  job.finishedAt = null;
  job.pauseReason = undefined;
  log("Resuming from where the crawl left off…");
  persist(true);
  void runCrawl(job, true).catch(e => {
    if (store.job) { store.job.status = "error"; store.job.finishedAt = new Date().toISOString(); }
    log(`Crawl failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    persist(true);
  });
  return { ok: true, kind: "restarted" };
}

function queueLabel(p: CrawlParams): string {
  return splitArtistList(p.artist ?? "").join(", ") || (p.link ?? "");
}

// The artists waiting for their turn, in order.
export function getCrawlQueue(): string[] {
  load();
  return store.queue!.map(queueLabel);
}

// Takes one artist (by its queue label, case-insensitive) out of the queue.
export function removeQueuedCrawl(label: string): boolean {
  load();
  const i = store.queue!.findIndex(q => queueLabel(q).toLowerCase() === label.toLowerCase());
  if (i < 0) return false;
  store.queue!.splice(i, 1);
  persistQueue();
  return true;
}

export function clearCrawlQueue(): number {
  load();
  const n = store.queue!.length;
  store.queue = [];
  persistQueue();
  return n;
}

// Lookup: starts a crawl for these params now if none is running, otherwise adds it to the
// queue (skipping an artist that is already crawling or queued). Queued crawls run
// sequentially as each one finishes (startNextQueued, from finish()).
export function enqueueCrawl(params: CrawlParams): { ok: true; started: boolean; queued: number } | { ok: false; error: string } {
  load();
  const bands = crawlBands(params);
  if (!bands.ok) return { ok: false, error: `BPM: ${bands.error}` };
  if (splitArtistList(params.artist ?? "").length === 0) return { ok: false, error: "an artist is required" };
  if (!isCrawlRunning()) {
    const r = startCrawl(params);
    return r.ok ? { ok: true, started: true, queued: store.queue!.length } : r;
  }
  const label = queueLabel(params).toLowerCase();
  const running = store.job ? queueLabel(store.job.params).toLowerCase() : "";
  if (label === running || store.queue!.some(q => queueLabel(q).toLowerCase() === label)) {
    return { ok: true, started: false, queued: store.queue!.length };
  }
  store.queue!.push(params);
  persistQueue();
  log(`Queued ${queueLabel(params)} (${store.queue!.length} waiting)`);
  return { ok: true, started: false, queued: store.queue!.length };
}

// After a crawl finishes normally: start the next queued one (skipping any that can't start).
function startNextQueued() {
  while (store.queue!.length > 0) {
    const next = store.queue!.shift()!;
    persistQueue();
    const r = startCrawl(next);
    if (r.ok) return;
    log(`Couldn't start the queued crawl for ${queueLabel(next)}: ${r.error}`, "error");
  }
}

// The effective-BPM bands a crawl accepts, from bpmSpec or the legacy fields.
function crawlBands(p: CrawlParams): BpmSpecResult {
  if (p.bpmSpec?.trim()) return parseBpmSpec(p.bpmSpec);
  if (p.bpmMin && p.bpmMax && p.bpmMin > 0 && p.bpmMax >= p.bpmMin) return parseBpmSpec(`${p.bpmMin}-${p.bpmMax}`);
  if (p.bpm && p.bpm > 0) return parseBpmSpec(String(p.bpm));
  return { ok: false, error: "a bpm, range or list of bpms is required" };
}

export function startCrawl(params: CrawlParams): { ok: true; id: string } | { ok: false; error: string } {
  load();
  if (isCrawlRunning()) return { ok: false, error: "A crawl is already running — stop it first." };
  const bandsRes = crawlBands(params);
  if (params.link?.trim() && !parseSpotifyLink(params.link)) {
    return { ok: false, error: "The link must be an open.spotify.com artist, album or playlist link" };
  }
  if (!params.artist?.trim() && !params.link?.trim()) {
    return { ok: false, error: "an artist or an album/playlist link is required" };
  }
  if (!bandsRes.ok) return { ok: false, error: `BPM: ${bandsRes.error}` };
  store.stopRequested = false;
  store.userPaused = false;
  // Songs from earlier crawls not yet accepted or deleted carry over — the
  // list is a review queue that persists across crawls. Ones no longer in
  // the library (deleted elsewhere) are dropped.
  let carried: CrawlJob["addedTracks"] = [];
  try {
    const libraryUris = new Set(readAllTracks(loadRunningPlaylistConfig().csvFile).map(t => t.uri));
    carried = (store.job?.addedTracks ?? []).filter(t => libraryUris.has(t.uri));
  } catch { carried = store.job?.addedTracks ?? []; }
  store.job = {
    id: randomUUID(), params, status: "running",
    startedAt: new Date().toISOString(), finishedAt: null,
    added: 0, addedTracks: carried, crawled: 0, totalArtists: 0, checked: 0, nextSeq: 0, log: [],
    checkpoint: freshCheckpoint(),
  };
  persist(true);
  void runCrawl(store.job).catch(e => {
    if (store.job) { store.job.status = "error"; store.job.finishedAt = new Date().toISOString(); }
    log(`Crawl failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    persist(true);
  });
  return { ok: true, id: store.job.id };
}

async function runCrawl(job: CrawlJob, resume = false) {
  const p = job.params;
  const ck: CrawlCheckpoint = (job.checkpoint ??= freshCheckpoint());
  // What a resumed crawl picks up from (read before the checkpoint is overwritten as it goes).
  const resumeStage = resume ? ck.stage : null;
  const resumeSeed = resume ? ck.seedIndex : 0;
  const resumeAlbum = resume ? ck.album : 0;
  const resumeLinkBatch = resume ? ck.linkBatch : 0;
  const restoredSpread = resume && (ck.stage === "spread" || ck.stage === "linkSpread")
    ? { queue: ck.queue.slice(), queued: ck.queued.slice(), crawlBase: ck.crawlBase, skipTopFor: ck.skipTopFor.slice() }
    : null;
  const maxArtists = Math.min(Math.max(Math.round(Number(p.maxArtists) || DEFAULT_MAX_ARTISTS), 1), MAX_ARTISTS_CAP);
  const bandsRes = crawlBands(p);
  const bands = bandsRes.ok ? bandsRes.bands : [];
  const inBands = (eff: number) => bands.some(b => eff >= b.lo && eff <= b.hi);
  const targetLabel = `${bandsRes.ok ? bandsRes.label : "?"} BPM`;
  const stopped = () => store.stopRequested;
  // Several artists can be typed, comma separated (a "quoted, name" keeps
  // its commas); each is crawled.
  const artistNames: string[] = [];
  for (const n of splitArtistList(p.artist ?? "")) {
    if (!artistNames.some(x => x.toLowerCase() === n.toLowerCase())) artistNames.push(n);
  }
  // Top-track titles of the artist a pasted artist link points at, by name -
  // used to pick the right Deezer artist when several share the name.
  const hintTitlesByName = new Map<string, string[]>();
  const parsedLink = parseSpotifyLink(p.link);
  // Artist links name the artist to crawl; only album / playlist links have tracks.
  const linkRef = parsedLink && parsedLink.kind !== "artist" ? { kind: parsedLink.kind, id: parsedLink.id } : null;
  if (parsedLink?.kind === "artist") {
    const linked = await fetchSpotifyArtist(parsedLink.id);
    const name = linked?.name;
    if (!linked || !name) {
      log("Couldn't read the artist's name from that Spotify link", "error");
      return finish(job, "done");
    }
    const typed = artistNames.findIndex(x => x.toLowerCase() === name.toLowerCase());
    if (typed >= 0) artistNames.splice(typed, 1);
    artistNames.unshift(name); // the exact artist from the link goes first
    hintTitlesByName.set(name.toLowerCase(), linked.topTitles);
    job.linkName = name;
  }
  const src = resolveSources(p);
  const doCatalogue = src.artist;
  const spreads = src.radio || src.related;
  const parts = [
    linkRef && `the ${linkRef.kind}'s tracks`,
    src.artist && artistNames.length > 0 && `${artistNames.join(", ")}'s own tracks`,
    src.radio && "artist radio",
    src.related && "related artists' top tracks",
  ].filter(Boolean).join(" + ");
  const scope = spreads ? `${parts} (up to ${maxArtists} artists)` : parts;

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
  // With hintTitles (from a pasted Spotify artist link), several same-named
  // Deezer artists are told apart by how many of the Spotify artist's top
  // tracks appear in theirs; no match falls back to the most-followed.
  const findArtist = async (name: string, hintTitles: string[] = []) => {
    const found = await deezer<{ data?: { id: number; name: string; nb_fan?: number }[] }>(`/search/artist?q=${encodeURIComponent(name)}&limit=25`);
    const matches = (found?.data ?? []).filter(a => a.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (matches.length <= 1 || hintTitles.length === 0) return matches[0] ?? null;
    const norm = (t: string) => t.toLowerCase().replace(/\s*[([-].*$/, "").replace(/[^a-z0-9À-￿]+/g, " ").trim();
    const wanted = new Set(hintTitles.map(norm).filter(Boolean));
    let best = { artist: matches[0], score: -1 };
    for (const cand of matches) {
      const top = await deezer<{ data?: { title: string }[] }>(`/artist/${cand.id}/top?limit=50`);
      const score = (top?.data ?? []).filter(t => wanted.has(norm(t.title))).length;
      if (score > best.score || (score === best.score && (cand.nb_fan ?? 0) > (best.artist.nb_fan ?? 0))) best = { artist: cand, score };
    }
    log(`${matches.length} Deezer artists are called "${name}" — picked the one (${best.artist.nb_fan?.toLocaleString() ?? "?"} fans) sharing ${Math.max(best.score, 0)} of the linked artist's top tracks`);
    return best.artist;
  };
  const resumedSeeds = resume && ck.seeds.length > 0;
  const seeds: { id: number; name: string }[] = resumedSeeds ? ck.seeds.slice() : [];
  if (!resumedSeeds) {
    for (const name of artistNames) {
      if (stopped()) break;
      const found = await findArtist(name, hintTitlesByName.get(name.toLowerCase()) ?? []);
      if (!found) { log(`No exact Deezer artist match for "${name}"`, "warn"); continue; }
      if (seeds.some(x => x.id === found.id)) continue;
      seeds.push({ id: found.id, name: found.name });
    }
    ck.seeds = seeds;
  }

  // Album / playlist link: its tracks, read from Spotify.
  let linkTracks: LinkTrack[] = [];
  if (linkRef) {
    const res = await fetchLinkTracks(linkRef.kind, linkRef.id);
    if ("error" in res) log(`Couldn't read the ${linkRef.kind}: ${res.error}`, "error");
    else {
      linkTracks = res.tracks;
      job.linkName = res.name;
      if (res.via) log(res.via, "warn");
      log(`${linkRef.kind === "album" ? "Album" : "Playlist"}: ${res.name} — ${linkTracks.length} track${linkTracks.length === 1 ? "" : "s"}`);
    }
  }
  if (seeds.length === 0 && linkTracks.length === 0) return finish(job, "done");
  if (!resume) job.totalArtists = 0;

  // Review limit: hold the crawl while too many songs await review.
  const reviewLimit = () => {
    const n = Number(job.params.reviewLimit);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const waitForReview = async () => {
    let lim = reviewLimit();
    if (!lim || job.addedTracks.length < lim || stopped()) return;
    job.status = "paused";
    job.pauseReason = "review";
    log(`Paused — ${job.addedTracks.length} songs awaiting review (limit ${lim}). Accept, delete or remove some to carry on.`, "warn");
    persist(true);
    while (!stopped()) {
      lim = reviewLimit();
      if (!lim || job.addedTracks.length < lim) break;
      await sleep(3000);
    }
    if (!stopped()) {
      job.status = "running";
      job.pauseReason = undefined;
      log(`Resumed — ${job.addedTracks.length} awaiting review.`);
      persist(true);
    }
  };

  // The user's Pause button: hold here (at a track boundary) until Resume or Stop.
  const waitIfPaused = async () => {
    if (!store.userPaused || stopped()) return;
    job.status = "paused";
    job.pauseReason = "user";
    log("Paused. Press Resume to carry on.", "warn");
    persist(true);
    while (store.userPaused && !stopped()) await sleep(1000);
    if (!stopped()) {
      job.status = "running";
      job.pauseReason = undefined;
      log("Resumed.");
      persist(true);
    }
  };

  const seenTracks = new Set<number>();
  const checkedIsrcs = new Set<string>();

  // BPM-checks one Deezer track and, on a match, adds it to the library.
  const checkTrack = async (t: DeezerRadioTrack, isrcHint?: string | null, durationHintSec?: number | null) => {
    await waitIfPaused();
    if (stopped()) return;
    await waitForReview();
    if (stopped()) return;
    if (seenTracks.has(t.id)) return;
    seenTracks.add(t.id);
    job.checked = (job.checked ?? 0) + 1;
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

    const eff = effRounded(tempo);
    if (!inBands(eff)) { log(`  ${label}: ${bpmLabel(tempo)}`); return; }

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
      job.addedTracks.push({ uri: resolved.uri, name: t.title, artist: t.artist.name, bpm: Math.round(tempo) });
      scheduleReviewSync(reviewUris);
      log(`  ✓ ADDED ${label} (${bpmLabel(tempo)})`, "match");
    } else {
      log(`  ${label}: matches, but was previously deleted from the library — skipped`, "warn");
    }
  };

  // One crawl: radio / related from the given starting artists, with its own
  // queue and its own Max artists budget. Every typed artist (and the
  // album's / playlist's artists) is a separate crawl, run one after another.
  // skipTopFor: artists whose whole catalogue was already checked, so their
  // top tracks are skipped.
  const crawlFrom = async (
    starts: { id: number; name: string }[], skipTopFor: Set<number>, stage: "spread" | "linkSpread",
    restored?: { queue: { id: number; name: string }[]; queued: number[]; crawlBase: number; skipTopFor: number[] } | null,
  ) => {
    // A resumed crawl rebuilds the queue as it stood when the artist being visited began.
    const queue = restored ? restored.queue.slice() : [...starts];
    const queuedArtists = new Set<number>(restored ? restored.queued : starts.map(x => x.id));
    const crawlBase = restored ? restored.crawlBase : job.totalArtists; // artists counted by earlier crawls in this job
    if (restored) {
      skipTopFor = new Set(restored.skipTopFor);
      job.crawled = Math.max(0, job.crawled - 1); // the artist being re-visited was already counted
    }
    job.totalArtists = crawlBase + queuedArtists.size;
    const enqueue = (a: { id: number; name: string }) => {
      if (queuedArtists.has(a.id) || queuedArtists.size >= maxArtists) return;
      queuedArtists.add(a.id);
      job.totalArtists = crawlBase + queuedArtists.size;
      if (queuedArtists.size === maxArtists) {
        log(`Reached ${maxArtists} artists — no more will be added; finishing the ${queue.length + 1} still queued.`, "warn");
      }
      queue.push(a);
    };

    while (queue.length > 0 && !stopped()) {
      await waitIfPaused();
      if (stopped()) break;
      const current = queue.shift()!;
      // Saved at the start of each artist: an interruption carries on from this one.
      ck.stage = stage;
      ck.queue = [current, ...queue];
      ck.queued = Array.from(queuedArtists);
      ck.crawlBase = crawlBase;
      ck.skipTopFor = Array.from(skipTopFor);
      persist(true);
      job.crawled++;
      const addedBefore = job.added;
      try {
      const what = [src.radio && "radio", src.related && "top tracks + related"].filter(Boolean).join(", ");
      log(`[${job.crawled}/${job.totalArtists}] ${current.name} — ${what} (${queue.length} still queued)`);

      if (src.related) {
        // Queue related artists first so they sit alongside the radio finds.
        const rel = await deezer<{ data?: { id: number; name: string }[] }>(`/artist/${current.id}/related?limit=${RELATED_LIMIT}`);
        const related = rel?.data ?? [];
        if (related.length) log(`  related: ${related.map(a => a.name).join(", ")}`);
        for (const a of related) enqueue({ id: a.id, name: a.name });
        if (!skipTopFor.has(current.id) && !stopped()) {
          const top = await deezer<{ data?: DeezerRadioTrack[] }>(`/artist/${current.id}/top?limit=${TOP_TRACKS_LIMIT}`);
          for (const t of top?.data ?? []) {
            if (stopped()) break;
            await checkTrack(t);
          }
        }
      }

      if (src.radio && !stopped()) {
        const radio = await deezer<{ data?: DeezerRadioTrack[] }>(`/artist/${current.id}/radio?limit=${RADIO_LIMIT}`);
        if (!radio?.data?.length) { log(`  no radio for ${current.name}`, "warn"); continue; }
        for (const t of radio.data) {
          if (stopped()) break;
          enqueue({ id: t.artist.id, name: t.artist.name });
          await checkTrack(t);
        }
      }
      } finally {
        // Logged once the artist was fully done (not when the crawl was stopped part-way through it).
        if (!stopped()) recordCrawledArtist({ id: current.id, name: current.name, added: job.added - addedBefore });
      }
    }
  };

  // Each artist, one after another: catalogue pass (every track credited to
  // them across all their releases; tracks credited to someone else are
  // skipped), then radio / related from them.
  const firstSeed = resumeStage === "linkTracks" || resumeStage === "linkSpread" ? seeds.length : resumeSeed;
  for (let si = firstSeed; si < seeds.length && !stopped(); si++) {
    const seed = seeds[si];
    const resumingThisSeed = si === resumeSeed && resume;
    if (seeds.length > 1) log(`── Artist ${si + 1} of ${seeds.length}: ${seed.name} ──`);
    ck.seedIndex = si;
    // On a resume that was already past this artist's catalogue (visiting artists), skip it.
    const catalogueDone = resumingThisSeed && resumeStage === "spread";
    const startAlbum = resumingThisSeed && resumeStage === "catalogue" ? resumeAlbum : 0;
    if (doCatalogue && !catalogueDone) {
    ck.stage = "catalogue";
    const addedAtCatalogueStart = job.added;
    const albums: { id: number; title: string }[] = [];
    let next: string | null = `/artist/${seed.id}/albums?limit=100`;
    while (next && !stopped()) {
      const page: { data?: { id: number; title: string }[]; next?: string } | null = await deezer(next);
      albums.push(...(page?.data ?? []));
      next = page?.next ? page.next.replace("https://api.deezer.com", "") : null;
    }
    log(`All tracks by ${seed.name}: ${albums.length} release${albums.length === 1 ? "" : "s"} to check`);
    if (startAlbum > 0) log(`Resuming at release ${startAlbum + 1} of ${albums.length}`);
    for (let i = startAlbum; i < albums.length; i++) {
      if (stopped()) break;
      await waitIfPaused();
      if (stopped()) break;
      ck.album = i;
      persist(true);
      const album = albums[i];
      const tracks = await deezer<{ data?: DeezerAlbumTrack[] }>(`/album/${album.id}/tracks?limit=200`);
      const own = (tracks?.data ?? []).filter(t => t.artist?.id === seed.id);
      log(`[release ${i + 1}/${albums.length}] ${album.title} (${own.length} track${own.length === 1 ? "" : "s"})`);
      for (const t of own) {
        if (stopped()) break;
        await checkTrack(t, t.isrc ?? null, t.duration ?? null);
      }
    }
    if (!stopped()) recordCrawledArtist({ id: seed.id, name: seed.name, added: job.added - addedAtCatalogueStart });
    if (!stopped()) log(spreads ? `Finished ${seed.name}'s catalogue — moving on to ${[src.radio && "radio", src.related && "related artists"].filter(Boolean).join(" and ")}.` : `Finished ${seed.name}'s catalogue.`);
    }
    if (spreads && !stopped()) {
      await crawlFrom([seed], new Set(doCatalogue ? [seed.id] : []), "spread", catalogueDone ? restoredSpread : null);
    }
  }

  // Every track on the album/playlist — BPM via ReccoBeats straight from
  // the Spotify track id (40 per request), added on a match.
  if (linkTracks.length > 0 && !stopped() && resumeStage !== "linkSpread") {
    log(`Checking the ${linkRef!.kind}'s ${linkTracks.length} tracks…`);
    for (let i = resumeStage === "linkTracks" ? resumeLinkBatch * 40 : 0; i < linkTracks.length && !stopped(); i += 40) {
      await waitIfPaused();
      if (stopped()) break;
      ck.stage = "linkTracks";
      ck.linkBatch = i / 40;
      persist(true);
      const batch = linkTracks.slice(i, i + 40);
      type Recco = { href?: string; isrc?: string; tempo?: number; key?: number; mode?: number; energy?: number; danceability?: number; valence?: number };
      let content: Recco[] = [];
      try {
        const res = await fetch(`https://api.reccobeats.com/v1/audio-features?ids=${batch.map(t => t.id).join(",")}`, {
          headers: { "User-Agent": "pacesync/0.1 (running playlist tool)" }, signal: AbortSignal.timeout(20000),
        });
        if (res.ok) content = ((await res.json()) as { content?: Recco[] }).content ?? [];
      } catch { /* logged per track below as no BPM */ }
      const byId = new Map<string, Recco>();
      for (const c of content) {
        const id = c.href?.match(/track\/([A-Za-z0-9]+)/)?.[1];
        if (id) byId.set(id, c);
      }
      for (const t of batch) {
        await waitForReview();
        if (stopped()) break;
        const label = `${t.name} — ${t.artist}`;
        job.checked = (job.checked ?? 0) + 1;
        const f = byId.get(t.id);
        if (knownUris.has(t.uri) || (f?.isrc && knownIsrcs.has(f.isrc))) { log(`  ${label}: already in library`); continue; }
        if (f?.tempo == null) { log(`  ${label}: no BPM available`); continue; }
        const tempo = f.tempo;
        if (!inBands(effRounded(tempo))) { log(`  ${label}: ${bpmLabel(tempo)}`); continue; }
        const result = await addTracksToLibrary([{
          uri: t.uri, isrc: f.isrc, name: t.name, artist: t.artist, tempo,
          key: f.key, mode: f.mode, energy: f.energy, danceability: f.danceability, valence: f.valence,
          ...(t.durationMs ? { durationMs: t.durationMs } : {}),
        }]);
        knownUris.add(t.uri);
        if (f.isrc) knownIsrcs.add(f.isrc);
        if (result.added > 0) {
          job.added++;
          job.addedTracks.push({ uri: t.uri, name: t.name, artist: t.artist, bpm: Math.round(tempo) });
          scheduleReviewSync(reviewUris);
          log(`  ✓ ADDED ${label} (${bpmLabel(tempo)})`, "match");
        } else {
          log(`  ${label}: matches, but was previously deleted from the library — skipped`, "warn");
        }
      }
    }
  }

  // The album's/playlist's artists are one more crawl, starting from them
  // (first credited artist of each track, exact Deezer name match, within
  // Max artists).
  if (spreads && linkTracks.length > 0 && !stopped()) {
    const starts: { id: number; name: string }[] = [];
    if (!(resumeStage === "linkSpread" && restoredSpread)) {
      const names = Array.from(new Set(linkTracks.map(t => t.artist.split(",")[0].trim()).filter(Boolean)));
      for (const name of names) {
        if (stopped() || starts.length >= maxArtists) break;
        const a = await findArtist(name);
        if (a && !starts.some(x => x.id === a.id)) starts.push({ id: a.id, name: a.name });
      }
      log(`Starting artists from the ${linkRef!.kind}: ${starts.length ? starts.map(a => a.name).join(", ") : "none found on Deezer"}`);
    }
    await crawlFrom(starts, new Set(), "linkSpread", resumeStage === "linkSpread" ? restoredSpread : null);
  }

  const n = `${job.added} track${job.added === 1 ? "" : "s"} added`;
  if (stopped()) log(`Stopped by you. ${n}.`, "warn");
  else if (spreads) log(`Crawl complete — no more artists to visit. ${n}.`);
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
  const bpmRes = crawlBands(p);
  const bpm = bpmRes.ok ? bpmRes.label : `${p.bpm}`;
  const mins = Math.round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 60000);
  const s = resolveSources(p);
  const scopeNote = s.radio || s.related ? `artist ${job.crawled} of ${job.totalArtists}` : "artist's own tracks";
  const what = [p.artist?.trim(), job.linkName].filter(Boolean).join(" + ") || "Song Crawler";
  const moreQueued = outcome === "done" && store.queue!.length > 0;
  // With more artists queued, only the last crawl sends the notification.
  if (!moreQueued) await cronNotify(
    `${what} · ${bpm} BPM — ${job.added} track${job.added === 1 ? "" : "s"} added, ${scopeNote}, ~${mins} min.`,
    {
      title: outcome === "stopped" ? "🕸 Song Crawler stopped" : "🕸 Song Crawler finished",
      tags: "spider_web",
      type: "song-crawler",
      priority: job.added > 0 ? "default" : "low",
    },
  ).catch(() => {});
  if (moreQueued) startNextQueued();
}
