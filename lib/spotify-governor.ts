import { getSpotifyBlockedUntil, getLastBlockEnd, setSpotifyBlockedUntil, parseRetryAfter, recordSpotifyRequest } from "@/lib/spotify-rate-limit";

// The one place server-side Spotify requests for BACKGROUND work go through (playlist saves, the
// delete queue, the review playlist, the nightly library sync). It keeps them inside Spotify's rate
// limit rules (developer.spotify.com/documentation/web-api/concepts/rate-limits: a rolling 30-second
// window per app; wait for Retry-After before calling again; slow down after a 429, don't just
// pause once; don't make bursts of unnecessary calls):
//   - ONE request at a time, never parallel, with a gap between requests (MIN_GAP_MS), so the
//     sustained rate is a fraction of any limit instead of a burst
//   - never sends while the shared "blocked until" marker is active: callers get SpotifyBlocked
//     and leave the work queued
//   - a 429 sets that marker from Retry-After (plus a buffer) and the call stops - no immediate retry
//   - once a block ends, a COOL-OFF: the first request waits a further 30 s, and for the next 15
//     minutes requests are spaced more widely, ramping back up gently rather than all at once
// One Spotify app and one login are used for all of this (the terms allow one security code per app,
// so no second app is used to get around a limit).

const MIN_GAP_MS = 2_000;
const COOL_OFF_GAP_MS = 6_000;
const COOL_OFF_WINDOW_MS = 15 * 60_000;
const COOL_OFF_FIRST_WAIT_MS = 30_000;
const RETRY_AFTER_BUFFER_MS = 30_000;

export class SpotifyBlocked extends Error {
  constructor(public until: string | null) {
    super(until ? `Spotify is rate-limiting until ${until}` : "Spotify is rate-limiting");
  }
}

type State = { chain: Promise<unknown>; nextAt: number };
const g = globalThis as unknown as { __spotifyGovernor?: State };
const st = (g.__spotifyGovernor ??= { chain: Promise.resolve(), nextAt: 0 });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// One governed request. Resolves with the response (any status except 429), or rejects with
// SpotifyBlocked when Spotify is blocking (before sending, or because this request drew the 429).
export function governedCall(url: string, init: RequestInit, token: string): Promise<Response> {
  const run = async (): Promise<Response> => {
    const blocked = await getSpotifyBlockedUntil("main");
    if (blocked) throw new SpotifyBlocked(blocked);

    const lastEnd = await getLastBlockEnd("main");
    const now = Date.now();
    const coolOff = lastEnd != null && now - lastEnd < COOL_OFF_WINDOW_MS;
    let wait = Math.max(0, st.nextAt - now);
    if (coolOff && lastEnd != null) wait = Math.max(wait, lastEnd + COOL_OFF_FIRST_WAIT_MS - now);
    if (wait > 0) await sleep(wait + Math.floor(Math.random() * 400)); // a little jitter

    const stillBlocked = await getSpotifyBlockedUntil("main"); // another caller may have drawn a 429 meanwhile
    if (stillBlocked) throw new SpotifyBlocked(stillBlocked);

    recordSpotifyRequest();
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    st.nextAt = Date.now() + (coolOff ? COOL_OFF_GAP_MS : MIN_GAP_MS);

    if (res.status === 429) {
      const wait429 = Math.min(parseRetryAfter(res.headers.get("Retry-After") ?? "30"), 24 * 3600);
      const until = new Date(Date.now() + wait429 * 1000 + RETRY_AFTER_BUFFER_MS).toISOString();
      await setSpotifyBlockedUntil(until, "main");
      console.warn(`[spotify-governor] 429 on ${init.method ?? "GET"} ${url.replace("https://api.spotify.com", "")} - waiting until ${until}`);
      throw new SpotifyBlocked(until);
    }
    return res;
  };
  const p = st.chain.then(run, run);
  st.chain = p.catch(() => undefined);
  return p;
}

// How long to wait before looking again after a SpotifyBlocked (capped so a long block is re-checked
// now and then rather than slept through).
export function blockedRetryMs(until: string | null, capMs = 10 * 60_000): number {
  if (!until) return 60_000;
  return Math.min(Math.max(new Date(until).getTime() - Date.now(), 5_000) + 5_000, capMs);
}
