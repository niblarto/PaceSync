import fs from "fs";
import os from "os";
import path from "path";
import { getDb } from "@/lib/db";
import { getSpotifyBlockedUntilByLane, getLastBlockEnd, getBurstCooldownRemainingMs } from "@/lib/spotify-rate-limit";
import { lookupAccountSummary } from "@/lib/spotify-lookup-account";
import { pendingPlaylistSaves } from "@/lib/spotify-outbox";
import { pendingSpotifyChangeSummary } from "@/lib/spotify-removals";
import { reviewPlaylistStatus } from "@/lib/review-playlist";
import { getCrawl, getCrawlQueue } from "@/lib/song-crawler";
import { loadGarminConfig } from "@/lib/garmin-config";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { getCachedPlaylistId } from "@/lib/playlist-id-cache";
import { buildNutritionDashboard } from "@/lib/nutrition-dashboard";
import { readAllTracks } from "@/lib/tracks-store";
import { getBackupState } from "@/lib/backup-settings";

// The Settings > Status tab: the state of each account and any restriction in effect, what is queued,
// the health of the server and of the external services. Everything here is read from local state or,
// for the "external services" section, from lightweight requests to NON-Spotify-API addresses - a
// status page never spends Spotify API allowance.

export type Level = "ok" | "warn" | "error" | "info";
export interface StatusItem { label: string; level: Level; detail: string }
export interface StatusSection { title: string; note?: string; items: StatusItem[] }
export interface StatusReport { generatedAt: string; live: boolean; sections: StatusSection[] }

const item = (label: string, level: Level, detail: string): StatusItem => ({ label, level, detail });

function kv<T>(key: string): T | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(key) as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as T) : null;
  } catch { return null; }
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(s / 3600);
  const mm = Math.round((s % 3600) / 60);
  if (h < 48) return `${h}h ${mm}m`;
  return `${Math.round(h / 24)} days`;
}
const clock = (iso: string | number) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const stamp = (iso: string | null | undefined) => (iso ? `${ago(Date.now() - new Date(iso).getTime())} ago` : "never");

async function timed<T>(p: Promise<T>, fallback: T): Promise<T> {
  try { return await p; } catch { return fallback; }
}

// ── accounts & restrictions ──
async function accountsSection(): Promise<StatusSection> {
  const items: StatusItem[] = [];
  const lanes = await timed(getSpotifyBlockedUntilByLane(), { main: null, search: null });
  const now = Date.now();

  // main Spotify account + app
  const tokens = kv<{ expiresAt?: number }>("spotify_tokens");
  const userId = kv<string>("spotify_user_id");
  if (!tokens) items.push(item("Spotify - main account", "error", "Not signed in on the server (no saved login). Playlist saves and deletes can't run."));
  else {
    const left = (tokens.expiresAt ?? 0) * 1000 - now;
    items.push(item("Spotify - main account", "ok", `Signed in${userId ? ` as ${userId}` : ""}. Access token ${left > 0 ? `valid for ${ago(left)}` : "expired (refreshed automatically on next use)"}.`));
  }
  if (lanes.main) {
    const lastEnd = new Date(lanes.main).getTime();
    items.push(item("Spotify - main app restriction", "error",
      `RATE-LIMITED until ${clock(lanes.main)} (in ${ago(lastEnd - now)}). Playlist saves, deletes, adds and the review playlist are queued and wait; playback may fail. First request after it ends waits ~30s, then a gentle cool-off.`));
  } else {
    const end = await getLastBlockEnd("main");
    if (end && now - end < 15 * 60_000) items.push(item("Spotify - main app restriction", "warn", `Cooling off after a rate limit that ended ${ago(now - end)} ago: requests are spaced 6s apart until ${clock(end + 15 * 60_000)}.`));
    else items.push(item("Spotify - main app restriction", "ok", "No rate limit in effect."));
  }
  const burst = getBurstCooldownRemainingMs();
  if (burst > 0) items.push(item("Spotify - request burst guard", "warn", `Too many recent requests: pausing browser-relayed Spotify calls for ${ago(burst)}.`));

  // lookup app + secondary account
  const lk = lookupAccountSummary();
  items.push(item("Spotify - lookup app", lk.configured ? "ok" : "info",
    lk.configured ? `Credentials set (${lk.clientIdHint}, ${lk.credentialsSource === "settings" ? "entered in Settings" : "from .env.local"}). Used for searches (no login) and the secondary account.` : "Not configured: lookups would use the main app."));
  if (lk.configured) {
    items.push(item("Spotify - secondary lookup account", lk.connected ? "ok" : "warn",
      lk.connected ? `Signed in${lk.accountId ? ` as ${lk.accountId}` : ""} (read-only). Access token ${lk.tokenLeftMs > 0 ? `valid for ${ago(lk.tokenLeftMs)}` : "expired (refreshed automatically)"}.` : "Not signed in: album/playlist reads and track checks can't run (the crawler falls back to Spotify's public page)."));
  }
  if (lanes.search) items.push(item("Spotify - lookup restriction", "error", `Lookups RATE-LIMITED until ${clock(lanes.search)} (in ${ago(new Date(lanes.search).getTime() - now)}). Searches wait; the main app is not used instead.`));
  else items.push(item("Spotify - lookup restriction", "ok", "No lookup rate limit in effect."));

  // Garmin
  const g = loadGarminConfig();
  if (!g) items.push(item("Garmin", "warn", "Not configured."));
  else {
    let detail = `Database ${g.dbPath}.`;
    let level: Level = "ok";
    try {
      const st = fs.statSync(path.join(g.dbPath, "garmin.db"));
      const age = now - st.mtimeMs;
      detail = `Local Garmin data last updated ${ago(age)} ago.`;
      if (age > 26 * 3600_000) level = "warn";
    } catch { level = "error"; detail = "The Garmin database file can't be read."; }
    items.push(item("Garmin Connect (local database)", level, detail));
  }

  // Strava
  const strava = kv<{ expiresAt?: number; athleteName?: string }>("strava_tokens");
  items.push(strava
    ? item("Strava", "ok", `Connected${strava.athleteName ? ` as ${strava.athleteName}` : ""}. Access token ${((strava.expiresAt ?? 0) * 1000 > now) ? `valid for ${ago((strava.expiresAt ?? 0) * 1000 - now)}` : "expired (refreshed automatically)"}.`)
    : item("Strava", "info", "Not connected."));

  // other integrations: configured or not
  const cfgs: [string, string][] = [
    ["Claude (AI)", "claude_config"], ["Gemini (AI)", "gemini_config"], ["Ollama web search", "ollama_web_search_key"],
    ["Coach", "coach_config"], ["ntfy notifications", "ntfy_config"], ["Discogs", "discogs_config"],
    ["Met Office weather", "metoffice_config"], ["Openrouteservice", "ors_api_key"], ["Phone push (FCM)", "fcm_config"],
  ];
  const set = cfgs.filter(([, key]) => kv(key) != null).map(([label]) => label);
  const unset = cfgs.filter(([, key]) => kv(key) == null).map(([label]) => label);
  items.push(item("Other integrations", "info", `Configured: ${set.join(", ") || "none"}.${unset.length ? ` Not configured: ${unset.join(", ")}.` : ""}${process.env.LASTFM_API_KEY ? " Last.fm key set." : ""}`));
  return { title: "Accounts & restrictions", items };
}

// ── what is queued ──
async function queueSection(): Promise<StatusSection> {
  const items: StatusItem[] = [];
  const lanes = await timed(getSpotifyBlockedUntilByLane(), { main: null, search: null });
  const retryNote = lanes.main ? ` Sent after about ${clock(new Date(lanes.main).getTime() + 35_000)}.` : "";

  const saves = pendingPlaylistSaves();
  if (saves.length === 0) items.push(item("Spotify playlist saves", "ok", "None waiting."));
  for (const s of saves) {
    items.push(item(`Playlist save: ${s.name}`, "warn", `${s.tracks} tracks, queued ${stamp(s.queuedAt)}, ${s.attempts} failed attempt(s).${retryNote}`));
  }

  const changes = pendingSpotifyChangeSummary();
  const known = new Map<string, string>();
  const lib = loadRunningPlaylistConfig();
  if (lib.id) known.set(lib.id, lib.name || "Running playlist");
  for (const [name] of [["pacesync review"], ["today's run"]]) { const id = getCachedPlaylistId(name); if (id) known.set(id, name === "pacesync review" ? "PaceSync review" : "Today's Run"); }
  if (changes.length === 0) items.push(item("Spotify playlist track changes", "ok", "None waiting."));
  for (const c of changes) {
    const name = known.get(c.playlistId) ?? `playlist ${c.playlistId.slice(0, 6)}…`;
    const parts = [c.removals ? `${c.removals} to remove` : "", c.adds ? `${c.adds} to add` : ""].filter(Boolean).join(", ");
    items.push(item(`Track changes: ${name}`, "warn", `${parts}.${retryNote}`));
  }

  const rp = reviewPlaylistStatus();
  items.push(item("Review playlist sync", rp.lastError ? "warn" : rp.pending ? "info" : "ok",
    rp.playlistId ? `${rp.synced ?? 0} songs in the Spotify playlist.${rp.pending ? " A sync is pending." : " Up to date."}${rp.lastError ? ` Last error: ${rp.lastError}` : ""}` : `Not created yet.${rp.pending ? " A sync is pending (waits for Spotify's limit)." : ""}`));

  const crawl = getCrawl(Number.MAX_SAFE_INTEGER).job;
  const q = getCrawlQueue();
  items.push(item("Song crawler", crawl && ["running", "paused", "stopping", "healing"].includes(crawl.status) ? "info" : "ok",
    crawl ? `${crawl.status}${crawl.pauseReason ? ` (${crawl.pauseReason})` : ""}: ${crawl.params.artist || "link"}, ${crawl.added} added, ${crawl.addedTracks.length} songs awaiting review.${crawl.resumable ? " Can be resumed." : ""}` : "No crawl yet."));
  items.push(item("Song crawler queue", q.length ? "info" : "ok", q.length ? `${q.length} artist(s) waiting: ${q.slice(0, 12).join(" → ")}${q.length > 12 ? " …" : ""}` : "Nothing queued."));
  return { title: "Queued items", note: "Anything waiting for Spotify's rate limit is sent automatically, slowly and in batches, once it ends.", items };
}

// ── freshness of the data feeds ──
function feedsSection(): StatusSection {
  const items: StatusItem[] = [];
  try {
    const s = buildNutritionDashboard(7).sources;
    const feed = (label: string, at: string | null, warnAfterH: number) => {
      const age = at ? Date.now() - new Date(at).getTime() : null;
      items.push(item(label, age == null ? "warn" : age > warnAfterH * 3600_000 ? "warn" : "ok", at ? `Last updated ${ago(age ?? 0)} ago.` : "No data yet."));
    };
    feed("Garmin weigh-ins", s.garminWeight, 3);
    feed("Today's calories burnt (Garmin)", s.todayBurn, 3);
    feed("Food log (Lose It! via phone)", s.food, 26);
    feed("Garmin database", s.garminDb, 26);
  } catch (e) { items.push(item("Data feeds", "error", `Couldn't read: ${e instanceof Error ? e.message : String(e)}`)); }
  return { title: "Data feeds", items };
}

// ── live checks of external (non-Spotify-API) services ──
async function ping(url: string, init: RequestInit = {}): Promise<{ ok: boolean; ms: number; status: number | null; error?: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5000), redirect: "manual" });
    return { ok: res.status < 500, ms: Date.now() - t0, status: res.status };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, status: null, error: e instanceof Error ? e.message : String(e) };
  }
}

async function servicesSection(): Promise<StatusSection> {
  const checks: [string, string, RequestInit | undefined][] = [
    ["Deezer (artist / track data)", "https://api.deezer.com/infos", undefined],
    ["ReccoBeats (audio features)", "https://api.reccobeats.com/v1/audio-features?ids=00000000", { headers: { "User-Agent": "pacesync-status" } }],
    ["Spotify sign-in service", "https://accounts.spotify.com/", undefined],
    ["ntfy.sh (push notifications)", "https://ntfy.sh/", undefined],
    ["Last.fm", "https://ws.audioscrobbler.com/2.0/", undefined],
  ];
  const results = await Promise.all(checks.map(([, url, init]) => ping(url, init)));
  const items = checks.map(([label], i) => {
    const r = results[i];
    return item(label, r.ok ? (r.ms > 2500 ? "warn" : "ok") : "error", r.ok ? `Reachable (${r.ms} ms, HTTP ${r.status}).` : `Unreachable: ${r.error ?? `HTTP ${r.status}`}.`);
  });
  return { title: "External services (live check)", note: "These checks never call the Spotify API, so they use none of its allowance.", items };
}

// ── the server itself ──
async function systemSection(): Promise<StatusSection> {
  const items: StatusItem[] = [];
  items.push(item("Server uptime", "info", `Machine up ${ago(os.uptime() * 1000)}; the app has been running ${ago(process.uptime() * 1000)} (Node ${process.version}).`));
  const load = os.loadavg();
  const cores = os.cpus().length || 1;
  items.push(item("CPU load", load[0] / cores > 1.5 ? "warn" : "ok", `${load.map(l => l.toFixed(2)).join(" / ")} (1/5/15 min) on ${cores} cores.`));
  const total = os.totalmem(), free = os.freemem();
  items.push(item("Memory", free / total < 0.1 ? "warn" : "ok", `${Math.round((total - free) / 1048576)} MB used of ${Math.round(total / 1048576)} MB; the app uses ${Math.round(process.memoryUsage().rss / 1048576)} MB.`));
  try {
    const st = fs.statfsSync(process.cwd());
    const freeGb = (st.bavail * st.bsize) / 1e9, totalGb = (st.blocks * st.bsize) / 1e9;
    items.push(item("Disk", freeGb < 2 ? "error" : freeGb < 5 ? "warn" : "ok", `${freeGb.toFixed(1)} GB free of ${totalGb.toFixed(0)} GB.`));
  } catch { /* statfs unavailable */ }
  try {
    const t = Number(fs.readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf8")) / 1000;
    items.push(item("CPU temperature", t > 80 ? "error" : t > 70 ? "warn" : "ok", `${t.toFixed(1)} °C.`));
  } catch { /* not a Pi */ }
  try {
    const db = path.join(process.cwd(), "pacesync.db");
    const st = fs.statSync(db);
    let wal = 0;
    try { wal = fs.statSync(`${db}-wal`).size; } catch { /* no WAL */ }
    items.push(item("Database", "ok", `${(st.size / 1048576).toFixed(1)} MB (+${(wal / 1048576).toFixed(1)} MB write-ahead log), last written ${ago(Date.now() - st.mtimeMs)} ago.`));
  } catch (e) { items.push(item("Database", "error", `Can't read the database: ${e instanceof Error ? e.message : String(e)}`)); }
  try {
    const cfg = loadRunningPlaylistConfig();
    const rows = readAllTracks(cfg.csvFile);
    items.push(item("Track library", "ok", `${rows.length.toLocaleString()} tracks in "${cfg.name || cfg.csvFile}".`));
  } catch (e) { items.push(item("Track library", "error", `Can't read the library: ${e instanceof Error ? e.message : String(e)}`)); }
  try {
    const build = fs.statSync(path.join(process.cwd(), ".next", "BUILD_ID"));
    items.push(item("Deployed", "info", `This version was built ${ago(Date.now() - build.mtimeMs)} ago.`));
  } catch { /* no build id */ }
  return { title: "Server", items };
}

// ── scheduled jobs: when each last ran ──
function cronSection(): StatusSection {
  const items: StatusItem[] = [];
  try {
    const dir = os.homedir();
    for (const f of fs.readdirSync(dir).filter(n => /^cron-.*\.log$/.test(n)).sort()) {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      let last = "";
      try { last = fs.readFileSync(full, "utf8").trim().split("\n").filter(Boolean).pop() ?? ""; } catch { /* unreadable */ }
      const bad = /fail|error|✗|unauthor/i.test(last);
      items.push(item(f.replace(/^cron-/, "").replace(/\.log$/, ""), bad ? "warn" : "ok", `Last ran ${ago(Date.now() - st.mtimeMs)} ago${last ? `: ${last.slice(0, 160)}` : ""}`));
    }
  } catch { /* home not readable */ }
  if (items.length === 0) items.push(item("Scheduled jobs", "info", "No job logs found."));
  return { title: "Scheduled jobs (last run)", items };
}

// ── nightly backup (lib/backup-settings.ts) ──
function backupSection(): StatusSection {
  const b = getBackupState();
  if (!b.supported) return { title: "Backup", items: [item("Backup", "info", "Only runs on the Raspberry Pi server.")] };
  const items: StatusItem[] = [];
  const next = b.nextRunAt ? new Date(b.nextRunAt) : null;
  items.push(item("Schedule", b.enabled ? "ok" : "warn",
    b.enabled ? `Every night at ${b.time}${next ? `; next run ${next.toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : ""}` : "Off: no backups are being made"));
  items.push(item("Destination", b.username && b.hasPassword ? "ok" : "error",
    `//${b.host}/${b.share}/${b.folder}, keeping ${b.keepDays} days${b.username && b.hasPassword ? "" : " (share login not set)"}`));
  const last = b.last;
  if (b.running) items.push(item("Running now", "info", "A backup is in progress."));
  if (!last) {
    items.push(item("Last backup", b.enabled ? "warn" : "info", "No backup has run yet."));
  } else {
    const done = last.finishedAt ?? last.startedAt;
    const age = done ? Date.now() - new Date(done).getTime() : Infinity;
    if (last.ok) {
      const mb = last.archiveBytes ? ` · archive ${(last.archiveBytes / 1048576).toFixed(1)} MB` : "";
      const stale = b.enabled && age > 36 * 3600_000;
      items.push(item("Last backup", stale ? "warn" : "ok",
        `${stamp(done)}: OK in ${last.seconds ?? "?"}s${mb}${stale ? " (overdue: expected nightly)" : ""}`));
      if (last.daily != null) items.push(item("Archives kept", "info", `${last.daily} daily${last.shareFreeGB != null ? ` · ${last.shareFreeGB} GB free on the share` : ""}`));
    } else {
      items.push(item("Last backup", "error", `${stamp(done)}: FAILED: ${last.error ?? "unknown error"}`));
    }
  }
  return { title: "Backup", items };
}

export async function buildStatusReport(live: boolean): Promise<StatusReport> {
  const sections: StatusSection[] = [];
  const add = async (fn: () => StatusSection | Promise<StatusSection>, title: string) => {
    try { sections.push(await fn()); } catch (e) { sections.push({ title, items: [item("Couldn't read", "error", e instanceof Error ? e.message : String(e))] }); }
  };
  await add(accountsSection, "Accounts & restrictions");
  await add(queueSection, "Queued items");
  if (live) await add(servicesSection, "External services (live check)");
  await add(feedsSection, "Data feeds");
  await add(systemSection, "Server");
  await add(backupSection, "Backup");
  await add(cronSection, "Scheduled jobs (last run)");
  return { generatedAt: new Date().toISOString(), live, sections };
}
