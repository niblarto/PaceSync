import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { readAllTracks } from "@/lib/tracks-store";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { resolveByIsrc } from "@/lib/track-enrich";
import { addTracksToLibrary } from "@/lib/library-add";
import { healActiveCsv } from "@/lib/csv-heal";
import { cronNotify } from "@/lib/cron-notify";
import { getFreshToken } from "@/lib/tokenStore";

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
export function parseSpotifyLink(link: string | undefined): { kind: "album" | "playlist"; id: string } | null {
  if (!link) return null;
  const m = link.trim().match(/(?:open\.spotify\.com\/(?:intl-[a-z]+\/)?|spotify:)(album|playlist)[/:]([A-Za-z0-9]{10,})/);
  return m ? { kind: m[1] as "album" | "playlist", id: m[2] } : null;
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
  const token = await getFreshToken();
  if (!token.ok) return { error: `no Spotify login on the server (${token.reason})` };
  const get = async (url: string) => {
    await sleep(300);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token.token}` }, signal: AbortSignal.timeout(20000) });
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
export type CrawlStatus = "running" | "stopping" | "healing" | "done" | "stopped" | "error" | "interrupted";

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
  /** open.spotify.com album or playlist link — its tracks are BPM-checked
      directly, and its artists join the typed artist as starting points
      for radio / related. */
  link?: string;
  bpm?: number;
  bpmMin?: number;
  bpmMax?: number;
  maxArtists?: number;
  sources?: Partial<CrawlSources>;
  mode?: CrawlMode;
}

export interface CrawlJob {
  id: string;
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

// Drops a song from the crawl's added list and notes it in the log —
// either deleted from the library, or accepted (kept, just reviewed).
export function removeCrawlAddedTrack(uri: string, reason: "deleted" | "accepted" = "deleted"): boolean {
  load();
  const job = store.job;
  if (!job?.addedTracks) return false;
  const i = job.addedTracks.findIndex(t => t.uri === uri);
  if (i < 0) return false;
  const [t] = job.addedTracks.splice(i, 1);
  if (reason === "accepted") log(`  ✓ Accepted ${t.name} — ${t.artist} (kept in the library)`);
  else log(`  ✗ Deleted ${t.name} — ${t.artist} from the library`, "warn");
  persist(true);
  return true;
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
  if (params.link?.trim() && !parseSpotifyLink(params.link)) {
    return { ok: false, error: "Album / Playlist must be an open.spotify.com album or playlist link" };
  }
  if ((!params.artist?.trim() && !params.link?.trim()) || (!isRange && !(params.bpm && params.bpm > 0))) {
    return { ok: false, error: "an artist or an album/playlist link, and a bpm (or bpmMin/bpmMax range), are required" };
  }
  store.stopRequested = false;
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
  const artist = (p.artist ?? "").trim();
  const linkRef = parseSpotifyLink(p.link);
  const src = resolveSources(p);
  const doCatalogue = src.artist;
  const spreads = src.radio || src.related;
  const parts = [
    linkRef && `the ${linkRef.kind}'s tracks`,
    src.artist && artist && `${artist}'s own tracks`,
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
  const findArtist = async (name: string) => {
    const found = await deezer<{ data?: { id: number; name: string }[] }>(`/search/artist?q=${encodeURIComponent(name)}&limit=25`);
    return found?.data?.find(a => a.name.trim().toLowerCase() === name.trim().toLowerCase()) ?? null;
  };
  const seed = artist ? await findArtist(artist) : null;
  if (artist && !seed) log(`No exact Deezer artist match for "${artist}"`, "warn");

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
  if (!seed && linkTracks.length === 0) return finish(job, "done");
  job.totalArtists = seed ? 1 : 0;

  const seenTracks = new Set<number>();
  const checkedIsrcs = new Set<string>();

  // BPM-checks one Deezer track and, on a match, adds it to the library.
  const checkTrack = async (t: DeezerRadioTrack, isrcHint?: string | null, durationHintSec?: number | null) => {
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
    if (!(eff >= lo && eff <= hi)) { log(`  ${label}: ${bpmLabel(tempo)}`); return; }

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
      log(`  ✓ ADDED ${label} (${bpmLabel(tempo)})`, "match");
    } else {
      log(`  ${label}: matches, but was previously deleted from the library — skipped`, "warn");
    }
  };

  // Optional catalogue pass: every track credited to the seed artist across
  // all their releases, before any radio. Tracks credited to someone else
  // (side projects, guest-led tracks) are skipped.
  if (doCatalogue && seed && !stopped()) {
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
    if (!stopped()) log(spreads ? `Finished ${seed.name}'s catalogue — moving on to ${[src.radio && "radio", src.related && "related artists"].filter(Boolean).join(" and ")}.` : `Finished ${seed.name}'s catalogue.`);
  }

  // Every track on the album/playlist — BPM via ReccoBeats straight from
  // the Spotify track id (40 per request), added on a match.
  if (linkTracks.length > 0 && !stopped()) {
    log(`Checking the ${linkRef!.kind}'s ${linkTracks.length} tracks…`);
    for (let i = 0; i < linkTracks.length && !stopped(); i += 40) {
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
        if (stopped()) break;
        const label = `${t.name} — ${t.artist}`;
        job.checked = (job.checked ?? 0) + 1;
        const f = byId.get(t.id);
        if (knownUris.has(t.uri) || (f?.isrc && knownIsrcs.has(f.isrc))) { log(`  ${label}: already in library`); continue; }
        if (f?.tempo == null) { log(`  ${label}: no BPM available`); continue; }
        const tempo = f.tempo;
        if (!(effRounded(tempo) >= lo && effRounded(tempo) <= hi)) { log(`  ${label}: ${bpmLabel(tempo)}`); continue; }
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
          log(`  ✓ ADDED ${label} (${bpmLabel(tempo)})`, "match");
        } else {
          log(`  ${label}: matches, but was previously deleted from the library — skipped`, "warn");
        }
      }
    }
  }

  const queue: { id: number; name: string }[] = seed ? [seed] : [];
  const queuedArtists = new Set<number>(seed ? [seed.id] : []);
  const enqueue = (a: { id: number; name: string }) => {
    if (queuedArtists.has(a.id) || queuedArtists.size >= maxArtists) return;
    queuedArtists.add(a.id);
    job.totalArtists = queuedArtists.size;
    if (queuedArtists.size === maxArtists) {
      log(`Reached ${maxArtists} artists — no more will be added; finishing the ${queue.length + 1} still queued.`, "warn");
    }
    queue.push(a);
  };

  // The album's/playlist's artists join the queue as starting points for
  // radio / related (first credited artist of each track, exact Deezer
  // name match, within Max artists).
  if (spreads && linkTracks.length > 0 && !stopped()) {
    const names = Array.from(new Set(linkTracks.map(t => t.artist.split(",")[0].trim()).filter(Boolean)));
    const found: string[] = [];
    for (const name of names) {
      if (stopped() || queuedArtists.size >= maxArtists) break;
      const a = await findArtist(name);
      if (a && !queuedArtists.has(a.id)) {
        queuedArtists.add(a.id);
        queue.push({ id: a.id, name: a.name });
        found.push(a.name);
      }
    }
    job.totalArtists = queuedArtists.size;
    log(`Starting artists from the ${linkRef!.kind}: ${found.length ? found.join(", ") : "none found on Deezer"}`);
  }

  while (spreads && queue.length > 0 && !stopped()) {
    const current = queue.shift()!;
    job.crawled++;
    const what = [src.radio && "radio", src.related && "top tracks + related"].filter(Boolean).join(", ");
    log(`[${job.crawled}/${queuedArtists.size}] ${current.name} — ${what} (${queue.length} still queued)`);

    if (src.related) {
      // Queue related artists first so they sit alongside the radio finds.
      const rel = await deezer<{ data?: { id: number; name: string }[] }>(`/artist/${current.id}/related?limit=${RELATED_LIMIT}`);
      const related = rel?.data ?? [];
      if (related.length) log(`  related: ${related.map(a => a.name).join(", ")}`);
      for (const a of related) enqueue({ id: a.id, name: a.name });
      // Top tracks — skipped for the typed artist when their whole
      // catalogue was already checked above.
      if (!(doCatalogue && seed && current.id === seed.id) && !stopped()) {
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
  const bpm = p.bpmMin && p.bpmMax ? `${p.bpmMin}–${p.bpmMax}` : `${p.bpm}`;
  const mins = Math.round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 60000);
  const s = resolveSources(p);
  const scopeNote = s.radio || s.related ? `artist ${job.crawled} of ${job.totalArtists}` : "artist's own tracks";
  const what = [p.artist?.trim(), job.linkName].filter(Boolean).join(" + ") || "Song Crawler";
  await cronNotify(
    `${what} · ${bpm} BPM — ${job.added} track${job.added === 1 ? "" : "s"} added, ${scopeNote}, ~${mins} min.`,
    {
      title: outcome === "stopped" ? "🕸 Song Crawler stopped" : "🕸 Song Crawler finished",
      tags: "spider_web",
      type: "song-crawler",
      priority: job.added > 0 ? "default" : "low",
    },
  ).catch(() => {});
}
