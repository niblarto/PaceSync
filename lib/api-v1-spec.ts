import SCHEMAS from "@/lib/api-v1-schemas.json";

// The read-only external API (/api/v1): one table drives BOTH the request routing (app/api/v1/[[...path]]/route.ts) and the
// OpenAPI document, so the documentation can't drift from what the API actually accepts.

export interface ApiParam {
  name: string; in: "query" | "path"; description: string; required?: boolean;
  type?: "string" | "integer" | "boolean"; example?: string | number; min?: number; max?: number; pattern?: string;
}
export interface ApiEndpoint {
  path: string;                 // e.g. /metrics/day or /activities/{id}
  internal: string;             // the app's own route that produces the data
  tag: string;
  summary: string;
  description: string;
  params?: ApiParam[];
  fixedQuery?: Record<string, string>;   // always sent to the internal route (e.g. sync=0)
  internalQuery?: Record<string, string>; // path params that become query params on the internal route, e.g. { id: "id" }
}

const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", example: "2026-11-24" } as const;

export const ENDPOINTS: ApiEndpoint[] = [
  // ── Metrics ─────────────────────────────────────────────────────────────────────────────────────
  {
    path: "/metrics/overview", internal: "/api/metrics/overview", tag: "Metrics",
    summary: "Daily health and activity metrics for the last N days",
    description: "One row per day (resting HR, HRV, sleep, steps, stress, Body Battery, calories in/out, running distance), the activities in the range, "
      + "hour-of-day heart-rate and stress heatmaps, and the current weight. Distances are miles, weight is lb (and kg where marked), paces are seconds per mile. "
      + "Data comes from the nightly GarminDB sync, so today's activities appear after the next sync.",
    params: [{ name: "days", in: "query", description: "Days to include, ending today.", type: "integer", min: 7, max: 30, example: 14 }],
  },
  {
    path: "/metrics/day", internal: "/api/metrics/day", tag: "Metrics",
    summary: "One day's heart rate and stress at 5-minute resolution, plus its runs and walks",
    description: "Everything recorded for a single calendar day.",
    params: [{ name: "date", in: "query", description: "Calendar day (local time).", required: true, ...DATE }],
  },
  {
    path: "/metrics/live", internal: "/api/metrics/live", tag: "Metrics",
    summary: "A day from midnight to now, straight from Garmin Connect, with the training and fitness scores",
    description: "Heart rate, stress, Body Battery, steps, breathing and SpO2 series (arrays of [epoch-ms, value] pairs); gauges (resting HR, steps, SpO2, sleep hours); "
      + "trainingStatus (label, acute/chronic load and ratio, VO2 max, load balance); racePredictions (5K, 10K, half, marathon in seconds, with 90-day history); "
      + "hillScore; enduranceScore; lactate (threshold heart rate and speed in m/s); sleepStages; and weight. Cached for 2 minutes and costs about 15 Garmin Connect calls, so don't poll it.",
    params: [{ name: "date", in: "query", description: "Calendar day (local time). Use today for live data.", required: true, ...DATE }],
  },
  // ── Health ──────────────────────────────────────────────────────────────────────────────────────
  {
    path: "/health/daily", internal: "/api/health/dashboard", tag: "Health",
    summary: "Sleep and HRV per day, with averages",
    description: "Per-day sleep duration, stages, sleep score, overnight HRV and its status, and resting heart rate, plus averages over the range.",
    params: [{ name: "days", in: "query", description: "Days to include, ending today.", type: "integer", min: 7, max: 120, example: 30 }],
  },
  {
    path: "/health/night", internal: "/api/health/night", tag: "Health",
    summary: "One night's detailed sleep",
    description: "Sleep stages as segments (deep, light, rem, awake; epoch-ms start/end), HRV readings every 5 minutes, sleep heart rate, the night's average HRV and sleep score. 404 when Garmin has no detailed data for that night.",
    params: [{ name: "date", in: "query", description: "The date you woke up.", required: true, ...DATE }],
  },
  {
    path: "/health/summary", internal: "/api/health/summary", tag: "Health",
    summary: "The latest AI-written health summary",
    description: "A short narrative summary of recent sleep and recovery, written once a day by PaceSync's own assistant.",
  },
  // ── Nutrition ───────────────────────────────────────────────────────────────────────────────────
  {
    path: "/nutrition/daily", internal: "/api/nutrition/dashboard", tag: "Nutrition",
    summary: "Calories in and out, weight history, averages and projections",
    description: "Daily calories eaten (from Lose It!) and burnt (from Garmin), macros, the weight history (weigh-ins, 7-day average), the target weight, and projections. Weight is kg unless a field says otherwise.",
    params: [{ name: "days", in: "query", description: "Days to include, ending today.", type: "integer", min: 7, max: 365, example: 30 }],
    fixedQuery: { sync: "0" },
  },
  {
    path: "/nutrition/summary", internal: "/api/nutrition/summary", tag: "Nutrition",
    summary: "The latest AI-written nutrition summary",
    description: "A short narrative summary of recent eating, written once a day by PaceSync's own assistant.",
  },
  // ── Activities ──────────────────────────────────────────────────────────────────────────────────
  {
    path: "/activities", internal: "/api/garmin/data", tag: "Activities",
    summary: "Garmin activities with summary statistics",
    description: "Every activity GarminDB holds (runs, walks, rides…) with distance (miles), duration, pace, heart rate, cadence, elevation, calories, training effect and training load, "
      + "plus daily summary rows (steps, resting HR, stress, distance), nightly sleep rows and weekly totals. Filtered by this API: without `from` it returns the last 90 days; "
      + "`activities` is newest first and capped by `limit` (default 100).",
    params: [
      { name: "from", in: "query", description: "First day to include (inclusive). Default: 90 days ago.", ...DATE },
      { name: "to", in: "query", description: "Last day to include (inclusive). Default: today.", ...DATE },
      { name: "sport", in: "query", description: "Only this sport, e.g. running, walking, cycling.", type: "string", example: "running" },
      { name: "limit", in: "query", description: "Most activities to return.", type: "integer", min: 1, max: 1000, example: 100 },
    ],
  },
  {
    path: "/activities/{id}", internal: "/api/garmin/activity/{id}", tag: "Activities",
    summary: "One activity in detail",
    description: "The activity's summary, laps/splits, a 10-second time series (pace, heart rate, cadence, elevation) and the route.",
    params: [{ name: "id", in: "path", description: "Garmin activity id (the activity_id from /activities).", required: true, type: "string", example: "12345678901" }],
  },
  // ── Training plan ───────────────────────────────────────────────────────────────────────────────
  {
    path: "/schedule", internal: "/api/runna/workouts", tag: "Training plan",
    summary: "The Runna training plan: scheduled and recent workouts",
    description: "Workouts from the Runna calendar feed with date, title, distance, description and structured segments. Each workout also has `route` and `tracklist` (both null when nothing is pinned): "
      + "`route` is the route pinned to that run (name, distanceMi, source = past-run or saved-route, `points` as [lat, lng] pairs and a Google-encoded `polyline` for drawing a map); "
      + "`paceProMixId` is the linked Pace Pro mix, if any; `tracklist` is the music for the run (source = pinned-mix or pace-pro; id, title, spotifyPlaylistId and spotifyPlaylistUrl when the mix has been saved to Spotify) as segments (warm up, intervals…), each with its target BPM and tracks (name, artist, startsAt mm:ss, durationSec, bpm, spotifyUrl).",
  },
  {
    path: "/races", internal: "/api/races", tag: "Training plan",
    summary: "Races, upcoming and completed",
    description: "Race name, date, status (upcoming or completed), distance (miles), the linked Garmin activity and notes.",
  },
  {
    path: "/races/{id}", internal: "/api/races/{id}", tag: "Training plan",
    summary: "One race",
    description: "A single race record.",
    params: [{ name: "id", in: "path", description: "Race id from /races.", required: true, type: "string" }],
  },
  {
    path: "/coach/reports", internal: "/api/coach/reports", tag: "Coach",
    summary: "Weekly coach reports",
    description: "The AI coach's weekly training reports, newest first.",
  },
  // ── Music ───────────────────────────────────────────────────────────────────────────────────────
  {
    path: "/playlists", internal: "/api/settings/playlists", tag: "Music",
    summary: "Running playlists and their track counts",
    description: "Every playlist PaceSync tracks (name, Spotify id, track count), and which one is active.",
  },
  {
    path: "/pace-pro", internal: "/api/settings/pace-pro-saved", tag: "Music",
    summary: "Saved Pace Pro mixes",
    description: "Tracklists built to match a race's per-split pace, each with its title, total time and timeline of tracks.",
  },
  {
    path: "/pace-pro/{id}", internal: "/api/settings/pace-pro-saved", tag: "Music",
    summary: "One saved Pace Pro mix",
    description: "The mix with its full timeline (track, artist, BPM, start and end second).",
    params: [{ name: "id", in: "path", description: "Mix id from /pace-pro.", required: true, type: "string" }],
    internalQuery: { id: "id" },
  },
];

// Matches a request path (without /api/v1) against the table; path params come back as `params`.
export function matchEndpoint(path: string): { ep: ApiEndpoint; params: Record<string, string> } | null {
  const segs = path.split("/").filter(Boolean);
  for (const ep of ENDPOINTS) {
    const pat = ep.path.split("/").filter(Boolean);
    if (pat.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    pat.forEach((p, i) => {
      if (p.startsWith("{")) params[p.slice(1, -1)] = decodeURIComponent(segs[i]);
      else if (p !== segs[i]) ok = false;
    });
    if (ok) return { ep, params };
  }
  return null;
}

// Validates and normalises a request's query string against the endpoint's declared parameters. Unknown parameters are
// dropped, so a caller can't pass anything through that the endpoint doesn't document.
export function checkParams(ep: ApiEndpoint, params: Record<string, string>, query: URLSearchParams): { ok: true; query: URLSearchParams } | { ok: false; error: string } {
  const out = new URLSearchParams();
  for (const p of ep.params ?? []) {
    const raw = p.in === "path" ? params[p.name] : query.get(p.name);
    if (raw == null || raw === "") {
      if (p.required) return { ok: false, error: `Missing required ${p.in} parameter '${p.name}'.` };
      continue;
    }
    if (p.type === "integer") {
      const n = Number(raw);
      if (!Number.isInteger(n)) return { ok: false, error: `'${p.name}' must be an integer.` };
      out.set(p.name, String(Math.min(p.max ?? n, Math.max(p.min ?? n, n))));
    } else {
      if (p.pattern && !new RegExp(p.pattern).test(raw)) return { ok: false, error: `'${p.name}' is not in the expected format (${p.example ?? p.pattern}).` };
      if (raw.length > 200) return { ok: false, error: `'${p.name}' is too long.` };
      if (p.in === "query") out.set(p.name, raw);
    }
  }
  for (const [k, v] of Object.entries(ep.fixedQuery ?? {})) out.set(k, v);
  for (const [k, from] of Object.entries(ep.internalQuery ?? {})) out.set(k, params[from]);
  return { ok: true, query: out };
}

export function buildOpenApi(baseUrl: string): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const ep of ENDPOINTS) {
    paths[ep.path] = {
      get: {
        tags: [ep.tag], summary: ep.summary, description: ep.description, operationId: ep.path.replace(/[{}]/g, "").split("/").filter(Boolean).map((s, i) => (i ? s[0].toUpperCase() + s.slice(1) : s)).join("").replace(/^/, "get_"),
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        parameters: (ep.params ?? []).map(p => ({
          name: p.name, in: p.in, required: p.in === "path" ? true : !!p.required, description: p.description,
          schema: { type: p.type ?? "string", ...(p.min != null ? { minimum: p.min } : {}), ...(p.max != null ? { maximum: p.max } : {}), ...(p.pattern ? { pattern: p.pattern } : {}), ...(p.example != null ? { example: p.example } : {}) },
        })),
        responses: {
          "200": { description: "The data as JSON. Fields marked x-optional are absent on some records; a type of [\"number\", \"null\"] means the value can be null.", content: { "application/json": { schema: (SCHEMAS as Record<string, unknown>)[ep.path] ?? { type: "object", additionalProperties: true } } } },
          "400": { $ref: "#/components/responses/Error" }, "401": { $ref: "#/components/responses/Error" },
          "404": { $ref: "#/components/responses/Error" }, "429": { $ref: "#/components/responses/RateLimited" },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "PaceSync API",
      version: "1.0.0",
      description:
        "Read-only access to one runner's data: Garmin activities and health metrics, training status and fitness scores, nutrition and weight, the Runna training plan, races, and running music.\n\n"
        + "**Authentication:** send your API key as `Authorization: Bearer psk_…` (or an `X-API-Key` header) on every request. Keys are created and revoked in PaceSync → Settings → API access.\n\n"
        + "**Limits:** 60 requests per minute per key (HTTP 429 with `Retry-After`). Every endpoint is GET only.\n\n"
        + "**Units:** distances are miles, paces are seconds per mile, weight is kg unless a field says lb. Times named `t`/`start`/`end` are epoch milliseconds; dates are `YYYY-MM-DD` in the runner's local time. "
        + "Health data is as fresh as the watch's last sync to Garmin Connect; activities and daily history are loaded by a nightly sync.\n\n"
        + "**Suggested use:** start with `/metrics/live?date=today` for the current state, `/metrics/overview` for trends, `/activities` for run history, and `/schedule` and `/races` for what is planned.",
    },
    servers: [{ url: baseUrl }],
    tags: Array.from(new Set(ENDPOINTS.map(e => e.tag))).map(name => ({ name })),
    paths,
    components: {
      securitySchemes: {
        ApiKeyBearer: { type: "http", scheme: "bearer", description: "Your PaceSync API key (starts with psk_)." },
        ApiKeyHeader: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
      responses: {
        Error: { description: "An error.", content: { "application/json": { schema: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } } } } } },
        RateLimited: { description: "Too many requests. Retry after the number of seconds in the Retry-After header.", headers: { "Retry-After": { schema: { type: "integer" } } }, content: { "application/json": { schema: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } } } } } },
      },
    },
  };
}

// /activities is large (hundreds of KB), so the gateway trims it to the requested window before it goes out.
export function filterActivities(data: Record<string, unknown>, q: URLSearchParams): Record<string, unknown> {
  const to = q.get("to") ?? "9999-12-31";
  const from = q.get("from") ?? new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const sport = q.get("sport")?.toLowerCase();
  const limit = Number(q.get("limit") ?? 100);
  const inRange = (d: unknown) => { const day = String(d ?? "").slice(0, 10); return day >= from && day <= to; };
  const rows = (k: string) => (Array.isArray(data[k]) ? data[k] as Record<string, unknown>[] : []);
  const activities = rows("activities").filter(a => inRange(a.start_time) && (!sport || String(a.sport ?? "").toLowerCase() === sport))
    .sort((a, b) => String(b.start_time).localeCompare(String(a.start_time))).slice(0, limit);
  return { from, to: to === "9999-12-31" ? null : to, daily: rows("daily").filter(r => inRange(r.day)), sleep: rows("sleep").filter(r => inRange(r.day)), activities, weekly: rows("weekly").filter(r => inRange(r.first_day)) };
}
