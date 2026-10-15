import { resolveByIsrc, sleep, type IsrcResolution } from "@/lib/track-enrich";

// Song-Crawler-style online search for tracks at an exact BPM — used by
// "Replace by BPM" (app/api/tracks/replace-candidates). Same walk as
// lib/song-crawler.ts's Artist + Radio modes, but read-only (nothing is
// added to the library) and stopping as soon as enough matches are found:
//   1. Artist: every track credited to the artist across all their releases.
//   2. Radio: the artist's Deezer radio, then the radio of each artist it
//      turns up, until maxArtists artists have been walked.
// Track length comes free with every Deezer listing, so tracks outside the
// caller's duration window are skipped before any per-track lookup.

const DEEZER_GAP_MS = 120; // Deezer allows 50 requests / 5 s

export interface CrawlMatch {
  deezerId: number;
  title: string;
  artist: string;
  isrc: string;
  durationMs: number;
  tempo: number;
  resolved: IsrcResolution;
}

export interface CrawlProgress {
  stage: string;   // e.g. "Bou — all tracks (release 3/12)" / "Radio 4/10: Hedex"
  name: string;
  artist: string;
  checked: number; // tracks BPM-checked so far
}

export interface BpmCrawlOptions {
  artist: string;
  isMatchBpm: (tempo: number) => boolean;
  durationOk: (ms: number | null) => boolean;
  /** Spotify URIs / ISRCs to skip (already in the mix or the results). */
  skipUri: (uri: string) => boolean;
  skipIsrc?: (isrc: string) => boolean;
  /** Extra filter on a BPM-matched track's features (e.g. energy band). */
  accept?: (r: IsrcResolution) => boolean;
  need: number;
  maxArtists?: number;
  /** Also walk Deezer's similar ("related") artists: each artist's related
      list joins the queue and their top tracks are checked, alongside radio. */
  similar?: boolean;
  onProgress?: (p: CrawlProgress) => void;
  onMatch: (m: CrawlMatch) => void;
  /** Checked between every request — true once the caller has gone away
      (e.g. the Replace window was closed), ending the crawl early. */
  shouldStop?: () => boolean;
}

// "Chom;Ragga Twins;Georgie Riot" / "A, B feat. C" -> the full string, then
// each credited artist.
export function splitArtists(artist: string): string[] {
  const parts = artist.split(/\s*(?:;|,|&|\bfeat\.?|\bft\.?|\bfeaturing\b)\s*/i).map(s => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  return [artist.trim(), ...parts].filter(a => {
    const k = a.toLowerCase();
    if (!a || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

interface DzTrack { id: number; title: string; duration?: number; isrc?: string; artist: { id?: number; name: string } }

async function deezer<T>(apiPath: string): Promise<T | null> {
  await sleep(DEEZER_GAP_MS);
  try {
    const res = await fetch(`https://api.deezer.com${apiPath}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const data = await res.json() as T & { error?: unknown };
    return data.error ? null : data;
  } catch {
    return null;
  }
}

export async function crawlForBpm(opts: BpmCrawlOptions): Promise<{ seedFound: boolean; checked: number; matched: number; artists?: string[] }> {
  const maxArtists = opts.maxArtists ?? 10;
  let matched = 0, checked = 0;
  const done = () => matched >= opts.need || !!opts.shouldStop?.();

  // Seeds: every credited artist with an exact Deezer name match (a track's
  // artist field can list several, e.g. "Chom;Ragga Twins;Georgie Riot").
  // Exact match so "Hybrid" never becomes "Hybrid Minds".
  const seeds: { id: number; name: string }[] = [];
  for (const name of splitArtists(opts.artist)) {
    if (done() || seeds.length >= 3) break;
    const found = await deezer<{ data?: { id: number; name: string }[] }>(`/search/artist?q=${encodeURIComponent(name)}&limit=25`);
    const hit = found?.data?.find(a => a.name.trim().toLowerCase() === name.toLowerCase());
    if (hit && !seeds.some(s => s.id === hit.id)) seeds.push(hit);
  }
  if (seeds.length === 0) return { seedFound: false, checked, matched };

  const seenIds = new Set<number>();
  const seenIsrcs = new Set<string>();

  const check = async (t: DzTrack, stage: string) => {
    if (done() || seenIds.has(t.id)) return;
    seenIds.add(t.id);
    // Cheap duration gate first — the listing already carries the length.
    if (t.duration != null && !opts.durationOk(t.duration * 1000)) return;
    if (t.isrc && (seenIsrcs.has(t.isrc) || opts.skipIsrc?.(t.isrc))) return;
    checked++;
    opts.onProgress?.({ stage, name: t.title, artist: t.artist.name, checked });
    const detail = await deezer<{ bpm?: number; isrc?: string; duration?: number }>(`/track/${t.id}`);
    const isrc = detail?.isrc ?? t.isrc;
    const durationSec = detail?.duration ?? t.duration ?? null;
    if (!isrc || durationSec == null || !opts.durationOk(durationSec * 1000)) return;
    if (seenIsrcs.has(isrc) || opts.skipIsrc?.(isrc)) return;
    seenIsrcs.add(isrc);
    // Deezer's bpm is 0 when unknown — ReccoBeats' tempo is the fallback.
    const deezerBpm = detail?.bpm && detail.bpm > 0 ? detail.bpm : null;
    if (deezerBpm != null && !opts.isMatchBpm(deezerBpm)) return;
    const resolved = await resolveByIsrc(isrc).catch(() => null);
    if (!resolved) return;
    const tempo = deezerBpm ?? resolved.tempo;
    if (!opts.isMatchBpm(tempo) || opts.skipUri(resolved.uri) || (opts.accept && !opts.accept(resolved))) return;
    matched++;
    opts.onMatch({ deezerId: t.id, title: t.title, artist: t.artist.name, isrc, durationMs: durationSec * 1000, tempo, resolved });
  };

  // 1. Every track credited to each seed artist, release by release.
  for (const seed of seeds) {
    if (done()) break;
    const albums: { id: number; title: string }[] = [];
    let next: string | null = `/artist/${seed.id}/albums?limit=100`;
    while (next && !done()) {
      const page: { data?: { id: number; title: string }[]; next?: string } | null = await deezer(next);
      albums.push(...(page?.data ?? []));
      next = page?.next ? page.next.replace("https://api.deezer.com", "") : null;
    }
    for (let i = 0; i < albums.length && !done(); i++) {
      const stage = `${seed.name} — all tracks (release ${i + 1}/${albums.length})`;
      opts.onProgress?.({ stage, name: albums[i].title, artist: seed.name, checked });
      const tracks = await deezer<{ data?: DzTrack[] }>(`/album/${albums[i].id}/tracks?limit=200`);
      const own = (tracks?.data ?? []).filter(t => t.artist?.id === seed.id);
      for (const t of own) {
        if (done()) break;
        await check(t, stage);
      }
    }
  }

  // 2. Artist radio (seeds first), spreading to the artists it turns up —
  // plus, with `similar`, each artist's similar artists and their top tracks.
  const queue: { id: number; name: string }[] = [...seeds];
  const queued = new Set<number>(seeds.map(s => s.id));
  const walked: string[] = [];
  const seedIds = new Set(seeds.map(s => s.id));
  const enqueue = (a: { id?: number; name: string } | undefined) => {
    if (a?.id != null && !queued.has(a.id) && queued.size < maxArtists) {
      queued.add(a.id);
      queue.push({ id: a.id, name: a.name });
    }
  };
  for (let n = 1; queue.length > 0 && !done(); n++) {
    const current = queue.shift()!;
    walked.push(current.name);
    const radio = await deezer<{ data?: DzTrack[] }>(`/artist/${current.id}/radio?limit=25`);
    const radioArtists = (radio?.data ?? []).map(t => t.artist);
    if (opts.similar && !done()) {
      // Alternate similar and radio artists when queueing — radio alone
      // (25 tracks, many artists) used to fill every Max-artists slot before
      // the similar artists were even considered.
      const rel = await deezer<{ data?: { id: number; name: string }[] }>(`/artist/${current.id}/related?limit=20`);
      const related = rel?.data ?? [];
      for (let k = 0; k < Math.max(related.length, radioArtists.length); k++) {
        if (k < related.length) enqueue(related[k]);
        if (k < radioArtists.length) enqueue(radioArtists[k]);
      }
    } else {
      for (const a of radioArtists) enqueue(a);
    }
    for (const t of radio?.data ?? []) {
      if (done()) break;
      await check(t, `Radio ${n}/${queued.size}: ${current.name}`);
    }
    // Similar artists' own top tracks (the seeds' catalogue was already
    // checked in step 1).
    if (opts.similar && !seedIds.has(current.id) && !done()) {
      const top = await deezer<{ data?: DzTrack[] }>(`/artist/${current.id}/top?limit=25`);
      for (const t of top?.data ?? []) {
        if (done()) break;
        await check(t, `Top tracks ${n}/${queued.size}: ${current.name}`);
      }
    }
  }

  return { seedFound: true, checked, matched, artists: walked };
}
