"use client";

import { TopNav } from "@/components/TopNav";
import Link from "next/link";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { SongProgressBar, ensurePlaying } from "@/components/SongProgressBar";
import { ArtistListInput } from "@/components/ArtistListInput";
import { playOnActiveDevice } from "@/components/TrackRow";
import { useFavourites } from "@/components/useFavourites";
import { useRunningPlaylist } from "@/components/useRunningPlaylist";
import { deleteTrackFromLibrary, deleteTracksFromLibrary } from "@/lib/track-delete-client";
import { parseBpmSpec } from "@/lib/bpm-spec";
import { formatArtistName } from "@/lib/artist-list";

// Song Crawler page: a server-side background job (lib/song-crawler.ts) that keeps running with
// the browser closed. This page starts/stops it, polls its log, and reviews the songs it found.
export function SongCrawlerClient() {
  const { data: session } = useSession();
  const runningPlaylist = useRunningPlaylist();

  // Artist names for the Artist field's autofill (the library's distinct artists).
  const [crawlerArtistOptions, setCrawlerArtistOptions] = useState<string[]>([]);
  useEffect(() => {
    fetch("/api/tracks/artists").then(r => r.json()).then((d: { artists?: string[] }) => setCrawlerArtistOptions(d.artists ?? [])).catch(() => {});
  }, []);

  // The run-type buttons fill the BPM field from Settings > BPM (Run BPM limits / Pace BPM).
  const [bpmOv, setBpmOv] = useState<Record<string, { min: string; max: string; sweet: string }>>({});
  const [paceBpmOv, setPaceBpmOv] = useState<Record<string, string>>({});
  useEffect(() => {
    fetch("/api/settings/bpm-overrides").then(r => r.json()).then((d: { overrides?: Record<string, { min?: number; max?: number; sweet?: number } & Record<string, number>> }) => {
      const o = d.overrides ?? {};
      const kinds = ["warmup", "work", "easy", "cooldown", "rest"];
      const next: Record<string, { min: string; max: string; sweet: string }> = {};
      for (const k of kinds) {
        const v = o[k] as { min?: number; max?: number; sweet?: number } | undefined;
        next[k] = { min: v?.min ? String(v.min) : "", max: v?.max ? String(v.max) : "", sweet: v?.sweet ? String(v.sweet) : "" };
      }
      setBpmOv(next);
      const pace = (o as unknown as { paceBpm?: Record<string, number> }).paceBpm ?? {};
      setPaceBpmOv(Object.fromEntries(Object.entries(pace).map(([k, v]) => [k, String(v)])));
    }).catch(() => {});
  }, []);

  // ── Song Crawler ── a server-side background job (lib/song-crawler.ts):
  // it keeps running with the browser closed. This page starts/stops it and
  // polls its log; only the form inputs are remembered in the browser.
  interface CrawlerLine { level: "info" | "match" | "warn" | "error"; msg: string; at: string }
  const [crawlerArtist, setCrawlerArtist] = useState("");
  // open.spotify.com album / playlist link — crawled alongside (or instead of) the artist.
  const [crawlerLink, setCrawlerLink] = useState("");
  // "120-122" range, "121,145,167" exact list, or one BPM (±1) — lib/bpm-spec.ts.
  const [crawlerBpm, setCrawlerBpm] = useState("");
  const crawlerBpmValid = parseBpmSpec(crawlerBpm).ok;
  // How many distinct artists a crawl may discover before it stops queuing.
  const [crawlerMaxArtists, setCrawlerMaxArtists] = useState("50");
  // Pause the crawl at this many songs awaiting review (empty = no limit).
  const [crawlerReviewLimit, setCrawlerReviewLimit] = useState("");
  // What to crawl — any combination (at least one): the artist's own
  // tracks, artist radio, related artists.
  const [crawlerSources, setCrawlerSources] = useState<{ artist: boolean; radio: boolean; related: boolean }>({ artist: false, radio: true, related: false });
  const crawlerSpreads = crawlerSources.radio || crawlerSources.related;
  const crawlerNoSource = !crawlerSources.artist && !crawlerSources.radio && !crawlerSources.related;
  // Artists processed so far / artists found so far.
  const [crawlerProgress, setCrawlerProgress] = useState<{ crawled: number; total: number } | null>(null);
  // What the log below is from.
  const [crawlerSeed, setCrawlerSeed] = useState<{ artist: string; bpmLabel: string; startedAt: string } | null>(null);
  const [crawlerRunning, setCrawlerRunning] = useState(false);
  const [crawlerStopping, setCrawlerStopping] = useState(false);
  // Paused with the Pause button (not the review limit), and whether an interrupted / stopped crawl can be resumed.
  const [crawlerUserPaused, setCrawlerUserPaused] = useState(false);
  const [crawlerResumable, setCrawlerResumable] = useState(false);
  const [crawlerControlBusy, setCrawlerControlBusy] = useState(false);
  const [crawlerStatusText, setCrawlerStatusText] = useState<string | null>(null);
  const [crawlerLog, setCrawlerLog] = useState<CrawlerLine[]>([]);
  const [crawlerAdded, setCrawlerAdded] = useState(0);
  const [crawlerChecked, setCrawlerChecked] = useState<number | null>(null);
  // Songs the current/last crawl added — the list beside the log.
  // The "PaceSync review" Spotify playlist mirroring the list (null until it's synced).
  const [crawlerReviewPlaylist, setCrawlerReviewPlaylist] = useState<string | null>(null);
  // The log of artists the crawler has visited (newest first), shown under the queue; it can be
  // minimized, and right-clicking an artist offers to send it to the queue.
  type CrawledArtist = { id: number; name: string; at: string; added: number; crawls: number };
  const [crawledArtists, setCrawledArtists] = useState<CrawledArtist[]>([]);
  const [crawledOpen, setCrawledOpen] = useState(true);
  const [artistMenu, setArtistMenu] = useState<{ x: number; y: number; name: string } | null>(null);
  // Artists waiting for their own crawl (right-click > Lookup), in order.
  const [crawlerQueue, setCrawlerQueue] = useState<string[]>([]);
  const [crawlerAddedTracks, setCrawlerAddedTracks] = useState<{ uri: string; name: string; artist: string; bpm: number }[]>([]);
  const [crawlerPlayingUri, setCrawlerPlayingUri] = useState<string | null>(null);
  const [crawlerMenu, setCrawlerMenu] = useState<{ x: number; y: number; uri: string; uris?: string[] } | null>(null);
  const { favourites, toggle: toggleFavourite } = useFavourites();
  // Awaiting-review multi-select: ctrl/cmd-click toggles, shift-click
  // selects a range from the last clicked song.
  const [crawlerSelected, setCrawlerSelected] = useState<Set<string>>(new Set());
  const crawlerAnchorRef = useRef<string | null>(null);

  const crawlerJobIdRef = useRef<string | null>(null);
  const crawlerSinceRef = useRef(0);
  const crawlerWasRunningRef = useRef(false);
  const crawlerLogRef = useRef<HTMLDivElement>(null);

  type CrawlJobMeta = {
    id: string; status: "running" | "paused" | "stopping" | "healing" | "done" | "stopped" | "error" | "interrupted";
    startedAt: string; added: number; crawled: number; totalArtists: number; checked?: number;
    addedTracks?: { uri: string; name: string; artist: string; bpm: number }[];
    params: { artist: string; bpmSpec?: string; bpm?: number; bpmMin?: number; bpmMax?: number };
    pauseReason?: "review" | "user";
    resumable?: boolean; // stopped / interrupted with a saved position it can carry on from
  };
  const CRAWLER_STATUS_TEXT: Record<CrawlJobMeta["status"], string> = {
    running: "Running", paused: "Paused — review limit reached", stopping: "Stopping", healing: "Filling in missing data",
    done: "Last crawl", stopped: "Last crawl (stopped)", error: "Last crawl (failed)", interrupted: "Last crawl (interrupted)",
  };

  // Pulls new log lines (and status) for the server's current/last crawl.
  const pollSongCrawler = useCallback(async () => {
    try {
      const res = await fetch(`/api/tracks/song-crawler?since=${crawlerSinceRef.current}`);
      if (!res.ok) return;
      const d = await res.json() as { job: CrawlJobMeta | null; lines: { seq: number; at: string; level: CrawlerLine["level"]; msg: string }[]; reviewPlaylist?: string | null; queue?: string[] };
      setCrawlerReviewPlaylist(d.reviewPlaylist ?? null);
      setCrawlerQueue(d.queue ?? []);
      if (!d.job) return;
      // A different crawl than the one shown — start its log from scratch.
      if (d.job.id !== crawlerJobIdRef.current) {
        crawlerJobIdRef.current = d.job.id;
        if (crawlerSinceRef.current !== 0) {
          crawlerSinceRef.current = 0;
          setCrawlerLog([]);
          return pollSongCrawler();
        }
        setCrawlerLog([]);
      }
      if (d.lines.length > 0) {
        crawlerSinceRef.current = d.lines[d.lines.length - 1].seq + 1;
        const mapped = d.lines.map(l => ({
          level: l.level, msg: l.msg,
          at: new Date(l.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        }));
        setCrawlerLog(prev => [...prev, ...mapped].slice(-5000));
      }
      const job = d.job;
      const running = job.status === "running" || job.status === "paused" || job.status === "stopping" || job.status === "healing";
      setCrawlerRunning(running);
      setCrawlerStopping(job.status === "stopping" || job.status === "healing");
      setCrawlerUserPaused(job.status === "paused" && job.pauseReason === "user");
      setCrawlerResumable(!!job.resumable && !running);
      setCrawlerStatusText(job.status === "paused" && job.pauseReason === "user" ? "Paused" : CRAWLER_STATUS_TEXT[job.status]);
      setCrawlerAdded(job.added);
      setCrawlerChecked(job.checked ?? null);
      setCrawlerAddedTracks(job.addedTracks ?? []);
      setCrawlerProgress(job.totalArtists > 0 ? { crawled: job.crawled, total: job.totalArtists } : null);
      const p = job.params;
      setCrawlerSeed({
        artist: p.artist,
        bpmLabel: p.bpmSpec?.trim() || (p.bpmMin && p.bpmMax ? `${Math.round(p.bpmMin)}–${Math.round(p.bpmMax)}` : String(Math.round(p.bpm ?? 0))),
        startedAt: new Date(job.startedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }),
      });
      // Crawl just ended while watching — show the tracks it added.
      crawlerWasRunningRef.current = running;
    } catch { /* transient — next poll retries */ }
  }, []);

  // Restore the current/last crawl on load; poll while one is running.
  useEffect(() => { void pollSongCrawler(); }, [pollSongCrawler]);
  useEffect(() => {
    if (!crawlerRunning) return;
    const id = setInterval(() => { void pollSongCrawler(); }, 2000);
    return () => clearInterval(id);
  }, [crawlerRunning, pollSongCrawler]);

  async function startSongCrawler() {
    if (crawlerRunning) return;
    const artist = crawlerArtist.trim();
    const link = crawlerLink.trim();
    const bpmSpec = crawlerBpm.trim();
    if ((!artist && !link) || !crawlerBpmValid || (crawlerNoSource && !link)) return;
    const res = await fetch("/api/tracks/song-crawler", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        artist,
        ...(link ? { link } : {}),
        bpmSpec,
        maxArtists: parseInt(crawlerMaxArtists, 10) > 0 ? parseInt(crawlerMaxArtists, 10) : 50,
        reviewLimit: parseInt(crawlerReviewLimit, 10) > 0 ? parseInt(crawlerReviewLimit, 10) : null,
        sources: crawlerSources,
      }),
    }).catch(() => null);
    const d = res ? await res.json().catch(() => ({})) as { id?: string; error?: string } : { error: "Couldn't reach the server" };
    if (!res?.ok || !d.id) {
      setCrawlerLog(prev => [...prev, { level: "error", msg: d.error ?? "Couldn't start the crawl", at: new Date().toLocaleTimeString("en-GB") }]);
      return;
    }
    crawlerJobIdRef.current = d.id;
    crawlerSinceRef.current = 0;
    crawlerWasRunningRef.current = true;
    setCrawlerLog([]);
    setCrawlerRunning(true);
    void pollSongCrawler();
  }

  // Delete a crawled song from the library (and Spotify playlist) and drop
  // it from the crawl's added list.
  async function deleteCrawlerTrack(uri: string) {
    setCrawlerMenu(null);
    void advanceIfPlaying([uri], crawlerAddedTracks.map(t => t.uri));
    setCrawlerAddedTracks(prev => prev.filter(t => t.uri !== uri));
    deleteTrackFromLibrary(uri, runningPlaylist.id);
    await fetch("/api/tracks/song-crawler", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ removeAdded: uri }),
    }).catch(() => null);
    void pollSongCrawler();
  }

  // Multi-select Accept / Delete — one request for the lot.
  // "removed": out of the library + playlist but not on the deleted list.
  async function bulkCrawlerAction(uris: string[], action: "accepted" | "deleted" | "removed") {
    setCrawlerMenu(null);
    setCrawlerSelected(new Set());
    const set = new Set(uris);
    void advanceIfPlaying(uris, crawlerAddedTracks.map(t => t.uri));
    setCrawlerAddedTracks(prev => prev.filter(t => !set.has(t.uri)));
    if (action !== "accepted") {
      void deleteTracksFromLibrary(uris, action === "removed");
    }
    await fetch("/api/tracks/song-crawler", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ removeAdded: uris, reason: action }),
    }).catch(() => null);
    void pollSongCrawler();
  }

  function clickCrawlerTrack(e: React.MouseEvent, uri: string) {
    if (e.shiftKey && crawlerAnchorRef.current) {
      const order = crawlerAddedTracks.map(t => t.uri);
      const a = order.indexOf(crawlerAnchorRef.current), b = order.indexOf(uri);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const range = order.slice(lo, hi + 1);
        setCrawlerSelected(prev => new Set([...(e.ctrlKey || e.metaKey ? Array.from(prev) : []), ...range]));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      crawlerAnchorRef.current = uri;
      setCrawlerSelected(prev => {
        const next = new Set(prev);
        if (next.has(uri)) next.delete(uri); else next.add(uri);
        return next;
      });
      return;
    }
    crawlerAnchorRef.current = uri;
    setCrawlerSelected(new Set());
    setCrawlerPlayingUri(uri);
    // On the active Spotify device (your phone, if that's what's playing).
    void playOnActiveDevice(uri, session?.accessToken, crawlerReviewPlaylist);
    ensurePlaying();
  }

  // When the song that is playing is accepted / deleted / removed, carry on with the
  // next one in the list (the first that isn't itself being removed). Checks Spotify for
  // what is actually playing rather than trusting the highlight, as the playlist moves on
  // by itself. `order` is the list as it was before the removal.
  async function advanceIfPlaying(removed: string[], order: string[]) {
    try {
      const res = await fetch("/api/spotify/playback");
      if (!res.ok) return;
      const st = await res.json() as { isPlaying?: boolean; trackUri?: string | null };
      if (!st.isPlaying || !st.trackUri || !removed.includes(st.trackUri)) return;
      const at = order.indexOf(st.trackUri);
      const next = order.slice(at + 1).find(u => !removed.includes(u)) ?? order.slice(0, at).find(u => !removed.includes(u));
      if (!next) return;
      setCrawlerPlayingUri(next);
      void playOnActiveDevice(next, session?.accessToken, crawlerReviewPlaylist);
    } catch { /* playback state unavailable - leave it */ }
  }

  // Right-click > Lookup: crawl the artists of these songs. Starts straight away if no crawl
  // is running; otherwise they join the queue and are crawled one after another. Uses the
  // BPM / sources / limits currently set above.
  async function lookupCrawlerArtists(uris: string[]) {
    setCrawlerMenu(null);
    const log = (level: "info" | "error", msg: string) =>
      setCrawlerLog(prev => [...prev, { level, msg, at: new Date().toLocaleTimeString("en-GB") }]);
    const names: string[] = [];
    for (const uri of uris) {
      const credit = crawlerAddedTracks.find(t => t.uri === uri)?.artist ?? "";
      const name = credit.split(";")[0].trim();
      if (name && !names.some(n => n.toLowerCase() === name.toLowerCase())) names.push(name);
    }
    await queueCrawlerArtists(names);
  }

  // Sends artists to the crawler: starts crawling the first now if nothing is running, otherwise
  // they join the queue (one after another). Uses the BPM / sources / limits set above.
  async function queueCrawlerArtists(names: string[]) {
    const log = (level: "info" | "error", msg: string) =>
      setCrawlerLog(prev => [...prev, { level, msg, at: new Date().toLocaleTimeString("en-GB") }]);
    if (!crawlerBpmValid) { log("error", "Lookup: enter a BPM, range or list above first."); return; }
    // Show who was looked up in the Artist field (several, comma separated; names with a comma quoted).
    if (names.length > 0) setCrawlerArtist(names.map(formatArtistName).join(", "));
    for (const name of names) {
      const res = await fetch("/api/tracks/song-crawler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enqueue: true,
          artist: formatArtistName(name),
          bpmSpec: crawlerBpm.trim(),
          maxArtists: parseInt(crawlerMaxArtists, 10) > 0 ? parseInt(crawlerMaxArtists, 10) : 50,
          reviewLimit: parseInt(crawlerReviewLimit, 10) > 0 ? parseInt(crawlerReviewLimit, 10) : null,
          sources: crawlerSources,
        }),
      }).catch(() => null);
      const d = res ? await res.json().catch(() => ({})) as { started?: boolean; queued?: number; error?: string } : { error: "Couldn't reach the server" };
      if (!res?.ok) { log("error", `Lookup ${name}: ${d.error ?? "failed"}`); continue; }
      log("info", d.started ? `Lookup: crawling ${name} now` : `Lookup: ${name} queued (${d.queued} waiting)`);
      if (d.started) {
        crawlerSinceRef.current = 0;
        crawlerWasRunningRef.current = true;
        setCrawlerRunning(true);
      }
    }
    void pollSongCrawler();
  }

  async function loadCrawledArtists() {
    const d = await fetch("/api/tracks/song-crawler/artists").then(r => r.json()).catch(() => null) as { artists?: CrawledArtist[] } | null;
    if (d?.artists) setCrawledArtists(d.artists);
  }
  useEffect(() => {
    void loadCrawledArtists();
    const id = setInterval(() => { void loadCrawledArtists(); }, crawlerRunning ? 5_000 : 20_000);
    return () => clearInterval(id);
  }, [crawlerRunning]);

  async function clearCrawledLog() {
    setCrawledArtists([]);
    await fetch("/api/tracks/song-crawler/artists", { method: "DELETE" }).catch(() => null);
  }

  async function removeQueuedArtist(label: string) {
    setCrawlerQueue(prev => prev.filter(q => q !== label));
    await fetch("/api/tracks/song-crawler", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ removeQueued: label }),
    }).catch(() => null);
    void pollSongCrawler();
  }

  async function clearCrawlerQueue() {
    await fetch("/api/tracks/song-crawler", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clearQueue: true }),
    }).catch(() => null);
    void pollSongCrawler();
  }

  // Keep the highlight on whatever is really playing (the playlist moves on by itself).
  const crawlerAddedRef = useRef(crawlerAddedTracks);
  crawlerAddedRef.current = crawlerAddedTracks;
  const hasCrawlerReview = crawlerAddedTracks.length > 0;
  useEffect(() => {
    if (!hasCrawlerReview) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/spotify/playback");
        if (!res.ok || stop) return;
        const st = await res.json() as { isPlaying?: boolean; trackUri?: string | null };
        const uri = st.isPlaying ? st.trackUri ?? null : null;
        setCrawlerPlayingUri(cur => (uri && crawlerAddedRef.current.some(t => t.uri === uri) ? uri : (uri ? null : cur)));
      } catch { /* ignore */ }
    };
    const id = setInterval(tick, 4000);
    return () => { stop = true; clearInterval(id); };
  }, [hasCrawlerReview]);

  // Accept: keep the song in the library, just take it off the review list.
  async function acceptCrawlerTrack(uri: string) {
    setCrawlerMenu(null);
    void advanceIfPlaying([uri], crawlerAddedTracks.map(t => t.uri));
    setCrawlerAddedTracks(prev => prev.filter(t => t.uri !== uri));
    await fetch("/api/tracks/song-crawler", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ removeAdded: uri, reason: "accepted" }),
    }).catch(() => null);
    void pollSongCrawler();
  }

  // Pause / Resume: pauses at the next track; resume un-pauses it, or carries on an interrupted
  // (or stopped) crawl from where it got to.
  async function pauseOrResumeCrawler() {
    setCrawlerControlBusy(true);
    const resuming = crawlerUserPaused || (!crawlerRunning && crawlerResumable);
    const res = await fetch("/api/tracks/song-crawler", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ crawlControl: resuming ? "resume" : "pause" }),
    }).catch(() => null);
    if (resuming && res?.ok) {
      crawlerWasRunningRef.current = true;
      setCrawlerRunning(true);
    }
    await pollSongCrawler();
    setCrawlerControlBusy(false);
  }

  async function stopSongCrawler() {
    setCrawlerStopping(true);
    await fetch("/api/tracks/song-crawler", { method: "DELETE" }).catch(() => null);
    void pollSongCrawler();
  }


  // The form's settings (artist, link, BPM, limits, sources) are kept on the SERVER
  // (api/tracks/song-crawler/inputs), so every browser shows the latest ones. They are saved a
  // moment after each edit, and this page re-reads them every 10 seconds and when you switch back
  // to it - unless you have an edit of your own that hasn't been saved yet.
  type CrawlerFormInputs = { artist: string; link: string; bpm: string; maxArtists: string; reviewLimit: string; sources: { artist: boolean; radio: boolean; related: boolean } };
  const currentInputs: CrawlerFormInputs = {
    artist: crawlerArtist, link: crawlerLink, bpm: crawlerBpm, maxArtists: crawlerMaxArtists,
    reviewLimit: crawlerReviewLimit, sources: crawlerSources,
  };
  const inputsRef = useRef(currentInputs);
  inputsRef.current = currentInputs;
  const inputsLoaded = useRef(false);
  const inputsSynced = useRef(""); // the last values known to match the server (JSON)
  const inputsStamp = useRef<string | null>(null); // the server's updatedAt for those

  const applyInputs = useCallback((i: CrawlerFormInputs, stamp: string | null) => {
    inputsSynced.current = JSON.stringify(i);
    inputsStamp.current = stamp;
    setCrawlerArtist(i.artist);
    setCrawlerLink(i.link);
    setCrawlerBpm(i.bpm);
    setCrawlerMaxArtists(i.maxArtists);
    setCrawlerReviewLimit(i.reviewLimit);
    setCrawlerSources(i.sources);
  }, []);

  // First load. If the server has nothing yet, bring this browser's old local settings across.
  useEffect(() => {
    (async () => {
      const d = await fetch("/api/tracks/song-crawler/inputs").then(r => r.json()).catch(() => null) as { inputs: (CrawlerFormInputs & { updatedAt: string | null }) | null } | null;
      if (d?.inputs) {
        applyInputs(d.inputs, d.inputs.updatedAt);
      } else {
        try {
          const raw = localStorage.getItem("pacesync.songCrawler.inputs");
          if (raw) {
            const old = JSON.parse(raw) as Partial<CrawlerFormInputs> & { bpmMax?: string };
            setCrawlerArtist(old.artist ?? "");
            setCrawlerLink(old.link ?? "");
            setCrawlerReviewLimit(old.reviewLimit ?? "");
            setCrawlerBpm(old.bpm ? (old.bpmMax && Number(old.bpmMax) > Number(old.bpm) ? `${old.bpm}-${old.bpmMax}` : old.bpm) : "");
            setCrawlerMaxArtists(old.maxArtists ?? "50");
            if (old.sources) setCrawlerSources(old.sources);
          }
        } catch { /* storage unavailable */ }
      }
      inputsLoaded.current = true;
    })();
  }, [applyInputs]);

  // Save a moment after each edit (never before the first load, which would overwrite the server's).
  useEffect(() => {
    if (!inputsLoaded.current) return;
    const snapshot = JSON.stringify(currentInputs);
    if (snapshot === inputsSynced.current) return; // nothing new (e.g. we just applied the server's values)
    const t = setTimeout(async () => {
      const d = await fetch("/api/tracks/song-crawler/inputs", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: snapshot,
      }).then(r => r.json()).catch(() => null) as { inputs?: { updatedAt: string | null } } | null;
      if (d?.inputs) { inputsSynced.current = snapshot; inputsStamp.current = d.inputs.updatedAt; }
    }, 600);
    return () => clearTimeout(t);
  }, [crawlerArtist, crawlerLink, crawlerBpm, crawlerMaxArtists, crawlerReviewLimit, crawlerSources]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow changes made in another browser (or by a Lookup from another page).
  useEffect(() => {
    const check = async () => {
      if (!inputsLoaded.current) return;
      if (JSON.stringify(inputsRef.current) !== inputsSynced.current) return; // an edit of ours is still unsaved
      const d = await fetch("/api/tracks/song-crawler/inputs").then(r => r.json()).catch(() => null) as { inputs: (CrawlerFormInputs & { updatedAt: string | null }) | null } | null;
      if (d?.inputs && d.inputs.updatedAt && d.inputs.updatedAt !== inputsStamp.current) applyInputs(d.inputs, d.inputs.updatedAt);
    };
    const id = setInterval(check, 10_000);
    const onVisible = () => { if (!document.hidden) void check(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", onVisible); };
  }, [applyInputs]);

  // Keep the log scrolled to the newest line.
  useEffect(() => {
    const el = crawlerLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [crawlerLog]);


  return (
    <div className="relative isolate min-h-screen flex flex-col text-slate-100">
      <div aria-hidden className="fixed inset-0 -z-10 bg-slate-950 bg-cover bg-center bg-no-repeat pointer-events-none"
        style={{ backgroundImage: "linear-gradient(rgba(2,6,23,0.85), rgba(2,6,23,0.85)), url('/dashboard-hero.png')" }} />
      <TopNav title="🕸 Song Crawler" maxWidth="max-w-[1800px]" />
      <main className="flex-1 max-w-[1800px] w-full mx-auto px-4 py-6 space-y-6">
      {/* ── Song Crawler ── always shown; the last crawl's log is kept. */}
      <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="font-semibold text-slate-100 flex items-center gap-2">
              <span className="text-teal-400">🕸</span> Song Crawler
              {crawlerRunning && <span className="inline-block w-2 h-2 rounded-full bg-teal-400 animate-pulse" />}
            </h3>
            <p className="text-xs text-slate-500">
              Walks Deezer artist radio from an artist — and/or every track on a Spotify album or playlist (or paste an artist link) — adding tracks at the BPM (±1) or within the range to the library. Half-time tracks count at double tempo.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-500 space-y-1 flex-1 min-w-[12rem]">
            <span className="block">Artist <span className="text-slate-600" title={'Separate artists with commas. Put a name that contains commas in quotes: "Earth, Wind & Fire", The Levellers'}>(comma separate several)</span></span>
            <ArtistListInput
              value={crawlerArtist}
              onChange={setCrawlerArtist}
              options={crawlerArtistOptions}
              onEnter={() => void startSongCrawler()}
              disabled={crawlerRunning}
              placeholder="Type to filter artists…"
              className="w-full rounded-lg bg-slate-800/60 border border-white/10 text-sm px-2.5 py-1.5 text-slate-100 disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
          </label>
          <label className="text-xs text-slate-500 space-y-1 flex-1 min-w-[14rem]" title="Spotify artist link (crawls that artist), or an album / playlist link — every track on it is BPM-checked, and its artists are used as starting points for Radio / Related">
            <span className="block">Artist / Album / Playlist link</span>
            <input
              value={crawlerLink}
              onChange={e => setCrawlerLink(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") void startSongCrawler(); }}
              disabled={crawlerRunning}
              placeholder="https://open.spotify.com/album/…"
              className={`w-full rounded-lg bg-slate-800/60 border text-sm px-2.5 py-1.5 text-slate-100 disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-teal-500 ${
                crawlerLink.trim() && !/open\.spotify\.com\/(?:intl-[a-z]+\/)?(album|playlist|artist)\/|spotify:(album|playlist|artist):/.test(crawlerLink) ? "border-amber-500/60" : "border-white/10"
              }`}
            />
          </label>
          <label className="text-xs text-slate-500 space-y-1 w-48" title="One BPM (±1), a range like 120-122, or exact matches like 121,145,167">
            <span className="block">BPM</span>
            <input
              type="text"
              value={crawlerBpm}
              onChange={e => setCrawlerBpm(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") void startSongCrawler(); }}
              disabled={crawlerRunning}
              placeholder="170 · 120-122 · 121,145,167"
              className={`w-full rounded-lg bg-slate-800/60 border text-sm px-2.5 py-1.5 text-slate-100 font-mono disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-teal-500 ${
                crawlerBpm.trim() && !crawlerBpmValid ? "border-amber-500/60" : "border-white/10"
              }`}
            />
          </label>
          <label className="text-xs text-slate-500 space-y-1 w-24" title="Stop queuing new artists once this many have been found (the queued ones are still finished)">
            <span className="block">Max artists</span>
            <input
              type="number"
              min={1}
              max={2000}
              value={crawlerMaxArtists}
              onChange={e => setCrawlerMaxArtists(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") void startSongCrawler(); }}
              // Only the radio crawl spreads to other artists.
              disabled={crawlerRunning || !crawlerSpreads}
              placeholder="50"
              className="w-full rounded-lg bg-slate-800/60 border border-white/10 text-sm px-2.5 py-1.5 text-slate-100 font-mono disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
          </label>
          <label className="text-xs text-slate-500 space-y-1 w-24" title="Pause the crawl once this many songs are awaiting review; it carries on when you've reviewed enough. Empty = no limit. Can be changed while a crawl runs.">
            <span className="block">Review limit</span>
            <input
              type="number"
              min={1}
              value={crawlerReviewLimit}
              onChange={e => setCrawlerReviewLimit(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { if (crawlerRunning) (e.target as HTMLInputElement).blur(); else void startSongCrawler(); } }}
              // While a crawl runs, a change applies to it straight away.
              onBlur={() => {
                if (!crawlerRunning) return;
                const n = parseInt(crawlerReviewLimit, 10);
                void fetch("/api/tracks/song-crawler", {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ reviewLimit: n > 0 ? n : null }),
                }).then(() => pollSongCrawler()).catch(() => {});
              }}
              placeholder="none"
              className="w-full rounded-lg bg-slate-800/60 border border-white/10 text-sm px-2.5 py-1.5 text-slate-100 font-mono focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
          </label>
          <button
            onClick={() => void startSongCrawler()}
            disabled={crawlerRunning || (!crawlerArtist.trim() && !crawlerLink.trim()) || !crawlerBpmValid || (crawlerNoSource && !crawlerLink.trim())}
            className="rounded-lg bg-teal-600 hover:bg-teal-500 disabled:bg-slate-700 disabled:text-slate-400 disabled:cursor-not-allowed text-white font-semibold text-sm px-5 py-2 shadow-sm transition-colors"
          >
            Crawl
          </button>
          {/* Pause a running crawl; resume a paused one, or carry on an interrupted / stopped one. */}
          <button
            onClick={() => void pauseOrResumeCrawler()}
            disabled={crawlerControlBusy || crawlerStopping || (!crawlerRunning && !crawlerResumable)}
            title={crawlerUserPaused ? "Carry on with the crawl" : !crawlerRunning && crawlerResumable ? "Carry on from where the interrupted crawl got to" : "Pause after the current track"}
            className="rounded-lg border border-amber-500/40 bg-amber-500/15 hover:bg-amber-500/25 disabled:opacity-30 disabled:cursor-not-allowed text-amber-300 font-semibold text-xs px-4 py-2 transition-colors"
          >
            {crawlerUserPaused || (!crawlerRunning && crawlerResumable) ? "▶ Resume" : "⏸ Pause"}
          </button>
          <button
            onClick={() => void stopSongCrawler()}
            disabled={!crawlerRunning || crawlerStopping}
            className="rounded-lg border border-red-500/40 bg-red-500/15 hover:bg-red-500/25 disabled:opacity-30 disabled:cursor-not-allowed text-red-300 font-semibold text-xs px-4 py-2 transition-colors"
          >
            {crawlerStopping ? "Stopping…" : "■ Stop"}
          </button>
          <button
            onClick={() => { setCrawlerLog([]); setCrawlerSeed(null); setCrawlerAdded(0); setCrawlerProgress(null); setCrawlerStatusText(null); }}
            disabled={crawlerRunning || crawlerLog.length === 0}
            className="rounded-lg border border-white/10 hover:border-white/20 disabled:opacity-30 disabled:cursor-not-allowed text-slate-400 hover:text-slate-200 text-xs px-3 py-2 transition-colors"
          >
            Clear log
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className="text-xs text-slate-500">Crawl:</span>
          {([
            ["artist", "Artist", "This artist's own tracks — every album, EP and single"],
            ["radio", "Radio", "Each artist's radio; artists in it are added to the queue (up to Max artists)"],
            ["related", "Related", "Each artist's related artists are added to the queue, and their top tracks checked (up to Max artists)"],
          ] as const).map(([key, label, hint]) => (
            <label key={key} title={hint} className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={crawlerSources[key]}
                onChange={e => setCrawlerSources(prev => ({ ...prev, [key]: e.target.checked }))}
                disabled={crawlerRunning}
                className="accent-teal-500"
              />
              {label}
            </label>
          ))}
          {crawlerNoSource && <span className="text-xs text-amber-400">Tick at least one</span>}
        </div>

        {/* Run-type ranges from "Run BPM limits" (Settings > BPM) — fills
            the BPM field (Work: the exact BPMs from the Pace BPM table); a type with no limits set is disabled. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-slate-500 mr-1">Run type:</span>
          {([
            ["warmup", "Warm up"],
            ["work", "Work"],
            ["easy", "Easy"],
            ["cooldown", "Cool down"],
            ["rest", "Rest"],
          ] as [string, string][]).map(([kind, label]) => {
            // Work uses the Pace BPM table (its exact BPMs as a list); the
            // other types use their min–max range.
            const min = Number(bpmOv[kind]?.min.trim() || NaN);
            const max = Number(bpmOv[kind]?.max.trim() || NaN);
            const paceList = kind === "work"
              ? Array.from(new Set(Object.values(paceBpmOv).map(v => Number(v)).filter(v => v > 0))).sort((a, b) => a - b)
              : [];
            const spec = kind === "work" ? paceList.join(",") : `${min}-${max}`;
            const valid = kind === "work" ? paceList.length > 0 : min > 0 && max >= min;
            const active = valid && crawlerBpm.trim() === spec;
            return (
              <button
                key={kind}
                onClick={() => setCrawlerBpm(spec)}
                disabled={!valid || crawlerRunning}
                title={valid ? `${label}: ${spec.replace("-", "–")} BPM` : `${label} has no BPM limits set (Settings → BPM)`}
                className={`text-xs rounded-lg border px-2.5 py-1 transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                  active
                    ? "border-teal-500/50 bg-teal-500/15 text-teal-300"
                    : "border-white/10 text-slate-400 hover:text-slate-200 hover:border-white/20"
                }`}
              >
                {label}{valid && kind !== "work" ? ` ${min}–${max}` : ""}
              </button>
            );
          })}
        </div>

        {/* Status (left, over the log) and the Spotify playback bar (right,
            over the "Awaiting review" list). */}
        {/* The bar block is exactly one column of the 4-column grid below
            (the "Awaiting review" list's width); the track name sits just
            left of it and the status takes what's left. */}
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <p className="flex-1 text-xs text-slate-500 min-w-0">
            {crawlerSeed && (
              <>
                {crawlerStatusText ?? (crawlerRunning ? "Running" : "Last crawl")}: {crawlerSeed.artist} · {crawlerSeed.bpmLabel} BPM · started {crawlerSeed.startedAt}{crawlerChecked != null ? ` · ${crawlerChecked.toLocaleString()} checked` : ""} · {crawlerAdded} added
                {crawlerProgress ? ` · Artist ${crawlerProgress.crawled} of ${crawlerProgress.total}` : ""}
              </>
            )}
          </p>
          <SongProgressBar className="contents" barClassName="shrink-0 w-full md:w-[calc((100%-2.25rem)/4)]" />
        </div>
        {/* The artists waiting for their own crawl, in the order they will run. */}
        <div className="rounded-lg border border-white/10 bg-slate-950/30 px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-slate-300">Queued for crawling ({crawlerQueue.length})</span>
            {crawlerQueue.length > 0 && (
              <button onClick={() => void clearCrawlerQueue()} className="text-xs text-sky-400 hover:text-sky-300 underline">Clear all</button>
            )}
          </div>
          {crawlerQueue.length === 0 ? (
            <p className="text-xs text-slate-600 mt-1">Nothing queued. Right-click a song and choose Lookup to add its artist; queued artists are crawled one after another.</p>
          ) : (
            <ol className="mt-1 max-h-40 overflow-y-auto space-y-0.5">
              {crawlerQueue.map((name, i) => (
                <li key={`${name}-${i}`} className="flex items-center gap-2 text-xs">
                  <span className="w-5 text-right text-slate-600 tabular-nums">{i + 1}.</span>
                  <span className="flex-1 min-w-0 truncate text-slate-200">{name}</span>
                  <button onClick={() => void removeQueuedArtist(name)} title="Take it out of the queue" className="text-slate-600 hover:text-red-400 px-1">✕</button>
                </li>
              ))}
            </ol>
          )}
        </div>

        {/* The artists the crawler has been through, newest first. */}
        <div className="rounded-lg border border-white/10 bg-slate-950/30 px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <button
              onClick={() => setCrawledOpen(o => !o)}
              className="flex items-center gap-1.5 text-xs font-medium text-slate-300 hover:text-white"
              aria-expanded={crawledOpen}
            >
              <span className="text-slate-500">{crawledOpen ? "▾" : "▸"}</span>
              Crawled artists ({crawledArtists.length})
            </button>
            {crawledOpen && crawledArtists.length > 0 && (
              <button onClick={() => void clearCrawledLog()} className="text-xs text-slate-500 hover:text-slate-300 underline">Clear</button>
            )}
          </div>
          {crawledOpen && (
            crawledArtists.length === 0 ? (
              <p className="text-xs text-slate-600 mt-1">No artists crawled yet. Right-click an artist here to send it to the queue.</p>
            ) : (
              <ul className="mt-1 max-h-56 overflow-y-auto divide-y divide-white/5">
                {crawledArtists.map(a => (
                  <li
                    key={a.id}
                    onContextMenu={e => { e.preventDefault(); setArtistMenu({ x: e.clientX, y: e.clientY, name: a.name }); }}
                    title="Right-click to send this artist to the crawler queue"
                    className="flex items-center gap-3 py-1 text-xs cursor-context-menu hover:bg-slate-800/40"
                  >
                    <span className="flex-1 min-w-0 truncate text-slate-200">{a.name}</span>
                    <span className={`shrink-0 tabular-nums ${a.added > 0 ? "text-emerald-400" : "text-slate-600"}`}>
                      {a.added > 0 ? `+${a.added}` : "0"} added
                    </span>
                    {a.crawls > 1 && <span className="shrink-0 text-slate-600">×{a.crawls}</span>}
                    <span className="shrink-0 w-28 text-right text-slate-600 tabular-nums">
                      {new Date(a.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
        {artistMenu && createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setArtistMenu(null)} onContextMenu={e => { e.preventDefault(); setArtistMenu(null); }} />
            <div
              className="fixed z-50 rounded-lg bg-slate-900 border border-white/10 shadow-xl py-1 w-52"
              style={{ left: Math.min(artistMenu.x, window.innerWidth - 220), top: Math.min(artistMenu.y, window.innerHeight - 80) }}
            >
              <p className="px-3 py-1 text-[11px] text-slate-500 truncate">{artistMenu.name}</p>
              <button
                onClick={() => { const name = artistMenu.name; setArtistMenu(null); void queueCrawlerArtists([name]); }}
                title="Crawl this artist: now if no crawl is running, otherwise queued"
                className="w-full text-left px-3 py-1.5 text-sm text-sky-300 hover:bg-sky-500/15 transition-colors"
              >
                ➕ Send to crawler queue
              </button>
            </div>
          </>,
          document.body,
        )}

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div
            ref={crawlerLogRef}
            className="md:col-span-3 h-[39.6rem] overflow-y-auto rounded-lg border border-white/10 bg-slate-950/70 p-3 font-mono text-[11px] leading-relaxed"
          >
            {crawlerLog.length === 0 ? (
              <p className="text-slate-600">No crawl yet — pick an artist and BPM, then press Crawl.</p>
            ) : crawlerLog.map((line, i) => (
              <div
                key={i}
                className={
                  line.level === "match" ? "text-teal-300 font-semibold"
                    : line.level === "warn" ? "text-amber-400"
                    : line.level === "error" ? "text-red-400"
                    : "text-slate-400"
                }
              >
                <span className="text-slate-600">{line.at}</span> {line.msg}
              </div>
            ))}
          </div>

          {/* Songs this crawl added — click to play, right-click to delete. */}
          <div className="h-[39.6rem] flex flex-col rounded-lg border border-white/10 bg-slate-950/70 overflow-hidden">
            <p className="px-3 py-2 text-xs font-semibold text-slate-300 border-b border-white/10 shrink-0">
              Awaiting review <span className="text-slate-500 font-normal">({crawlerAddedTracks.length})</span>
              {crawlerSelected.size > 0 && (
                <span className="ml-2 text-sky-300 font-normal">
                  {crawlerSelected.size} selected
                  <button onClick={() => setCrawlerSelected(new Set())} className="ml-1.5 text-slate-500 hover:text-slate-300 underline">clear</button>
                </span>
              )}
            </p>
            <div className="flex-1 overflow-y-auto">
              {crawlerAddedTracks.length === 0 ? (
                <p className="px-3 py-2 text-xs text-slate-600">Songs crawls add stay here until you accept or delete them.</p>
              ) : crawlerAddedTracks.map(t => (
                <button
                  key={t.uri}
                  onClick={e => clickCrawlerTrack(e, t.uri)}
                  onMouseDown={e => { if (e.shiftKey) e.preventDefault(); /* no text selection on shift-click */ }}
                  onContextMenu={e => {
                    e.preventDefault();
                    if (crawlerSelected.size > 1 && crawlerSelected.has(t.uri)) {
                      setCrawlerMenu({ x: e.clientX, y: e.clientY, uri: t.uri, uris: crawlerAddedTracks.map(x => x.uri).filter(u => crawlerSelected.has(u)) });
                    } else {
                      setCrawlerSelected(new Set());
                      setCrawlerMenu({ x: e.clientX, y: e.clientY, uri: t.uri });
                    }
                  }}
                  title="Click to play · ctrl-click / shift-click to select several · right-click to accept or delete"
                  className={`w-full text-left px-3 py-1.5 border-b border-white/5 transition-colors select-none ${
                    crawlerSelected.has(t.uri)
                      ? "bg-sky-500/20 hover:bg-sky-500/25 shadow-[inset_3px_0_0_rgb(56,189,248)]"
                      : crawlerPlayingUri === t.uri ? "bg-teal-500/10 hover:bg-slate-800/60" : "hover:bg-slate-800/60"
                  }`}
                >
                  <span className={`block text-xs truncate ${crawlerPlayingUri === t.uri ? "text-teal-300" : "text-slate-200"}`}>{favourites.has(t.uri) && <span className="text-yellow-400 mr-1" title="Favourite">★</span>}{t.name}</span>
                  <span className="block text-[10px] text-slate-500 truncate">{t.artist} · {t.bpm} BPM{t.bpm > 0 && t.bpm < 95 ? ` (×2 = ${t.bpm * 2})` : ""}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Portalled to <body>: this panel's backdrop-blur makes it the
            containing block for position:fixed, which put the menu at the
            mouse position measured from the panel instead of the window
            (off-screen). */}
        {crawlerMenu && createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setCrawlerMenu(null)} onContextMenu={e => { e.preventDefault(); setCrawlerMenu(null); }} />
            {crawlerMenu.uris && crawlerMenu.uris.length > 1 ? (
            <div
              className="fixed z-50 rounded-lg bg-slate-900 border border-white/10 shadow-xl py-1 w-48"
              style={{ left: Math.min(crawlerMenu.x, window.innerWidth - 200), top: Math.min(crawlerMenu.y, window.innerHeight - 140) }}
            >
              <p className="px-3 py-1 text-[11px] text-slate-500">{crawlerMenu.uris.length} songs selected</p>
              <button
                onClick={() => void bulkCrawlerAction(crawlerMenu.uris!, "accepted")}
                title="Keep them in the library and remove them from this list"
                className="w-full text-left px-3 py-1.5 text-sm text-emerald-400 hover:bg-emerald-500/15 transition-colors"
              >
                ✓ Accept {crawlerMenu.uris.length}
              </button>
              <button
                onClick={() => void bulkCrawlerAction(crawlerMenu.uris!, "deleted")}
                className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/15 transition-colors"
              >
                🗑 Delete {crawlerMenu.uris.length}
              </button>
              <button
                onClick={() => void bulkCrawlerAction(crawlerMenu.uris!, "removed")}
                title="Take them out of the library and Spotify playlist without marking them deleted — they can be added again later"
                className="w-full text-left px-3 py-1.5 text-sm text-amber-300 hover:bg-amber-500/15 transition-colors"
              >
                ↩ Remove {crawlerMenu.uris.length}
              </button>
              <button
                onClick={() => void lookupCrawlerArtists(crawlerMenu.uris!)}
                title="Crawl these songs' artists, one after another"
                className="w-full text-left px-3 py-1.5 text-sm text-sky-300 hover:bg-sky-500/15 transition-colors"
              >
                🔎 Lookup {crawlerMenu.uris.length}
              </button>
            </div>
            ) : (
            <div
              className="fixed z-50 rounded-lg bg-slate-900 border border-white/10 shadow-xl py-1 w-40"
              style={{ left: Math.min(crawlerMenu.x, window.innerWidth - 170), top: Math.min(crawlerMenu.y, window.innerHeight - 160) }}
            >
              <button
                onClick={() => { const uri = crawlerMenu.uri; setCrawlerMenu(null); setCrawlerPlayingUri(uri); void playOnActiveDevice(uri, session?.accessToken, crawlerReviewPlaylist); ensurePlaying(); }}
                className="w-full text-left px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 transition-colors"
              >
                ▶ Play
              </button>
              <button
                onClick={() => void acceptCrawlerTrack(crawlerMenu.uri)}
                title="Keep it in the library and remove it from this list"
                className="w-full text-left px-3 py-1.5 text-sm text-emerald-400 hover:bg-emerald-500/15 transition-colors"
              >
                ✓ Accept
              </button>
              <button
                onClick={() => void deleteCrawlerTrack(crawlerMenu.uri)}
                className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/15 transition-colors"
              >
                🗑 Delete
              </button>
              <button
                onClick={() => void bulkCrawlerAction([crawlerMenu.uri], "removed")}
                title="Take it out of the library and Spotify playlist without marking it deleted — it can be added again later"
                className="w-full text-left px-3 py-1.5 text-sm text-amber-300 hover:bg-amber-500/15 transition-colors"
              >
                ↩ Remove
              </button>
              <button
                onClick={() => void lookupCrawlerArtists([crawlerMenu.uri])}
                title="Crawl this artist: now if no crawl is running, otherwise queued"
                className="w-full text-left px-3 py-1.5 text-sm text-sky-300 hover:bg-sky-500/15 transition-colors"
              >
                🔎 Lookup
              </button>
              <button
                onClick={() => { const uri = crawlerMenu.uri; setCrawlerMenu(null); toggleFavourite(uri); }}
                title="Favourites are used first in Pace Pro / Race mixes at their BPM"
                className="w-full text-left px-3 py-1.5 text-sm text-yellow-300 hover:bg-yellow-500/15 transition-colors"
              >
                {favourites.has(crawlerMenu.uri) ? "★ Unfavourite" : "☆ Favourite"}
              </button>
            </div>
            )}
          </>,
          document.body,
        )}
      </div>

      </main>
    </div>
  );
}
