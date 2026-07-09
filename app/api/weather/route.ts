import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadMetOfficeConfig } from "@/lib/metoffice-config";

// Run-time weather for the next week, from the Met Office DataHub
// site-specific three-hourly forecast. Returns one summary per date, sampled
// at the user's usual run time: midday on weekdays, 10:00 on weekends.

interface TimeStep {
  time: string; // ISO UTC
  maxScreenAirTemp?: number;
  feelsLikeTemp?: number;
  probOfPrecipitation?: number;
  windSpeed10m?: number; // m/s
  windGustSpeed10m?: number;
  significantWeatherCode?: number;
}

export interface DayWeather {
  tempC: number;
  feelsLikeC: number;
  precipProb: number;
  windMph: number;
  code: number;
  description: string;
  emoji: string;
  sampledAt: string; // local HH:MM the forecast was sampled for
}

// Met Office significant weather codes → label + emoji.
const WEATHER_CODES: Record<number, { description: string; emoji: string }> = {
  0: { description: "Clear", emoji: "🌙" },
  1: { description: "Sunny", emoji: "☀️" },
  2: { description: "Partly cloudy", emoji: "⛅" },
  3: { description: "Partly cloudy", emoji: "⛅" },
  5: { description: "Mist", emoji: "🌫️" },
  6: { description: "Fog", emoji: "🌫️" },
  7: { description: "Cloudy", emoji: "☁️" },
  8: { description: "Overcast", emoji: "☁️" },
  9: { description: "Light rain shower", emoji: "🌦️" },
  10: { description: "Light rain shower", emoji: "🌦️" },
  11: { description: "Drizzle", emoji: "🌦️" },
  12: { description: "Light rain", emoji: "🌧️" },
  13: { description: "Heavy rain shower", emoji: "🌧️" },
  14: { description: "Heavy rain shower", emoji: "🌧️" },
  15: { description: "Heavy rain", emoji: "🌧️" },
  16: { description: "Sleet shower", emoji: "🌨️" },
  17: { description: "Sleet shower", emoji: "🌨️" },
  18: { description: "Sleet", emoji: "🌨️" },
  19: { description: "Hail shower", emoji: "🌨️" },
  20: { description: "Hail shower", emoji: "🌨️" },
  21: { description: "Hail", emoji: "🌨️" },
  22: { description: "Light snow shower", emoji: "🌨️" },
  23: { description: "Light snow shower", emoji: "🌨️" },
  24: { description: "Light snow", emoji: "❄️" },
  25: { description: "Heavy snow shower", emoji: "❄️" },
  26: { description: "Heavy snow shower", emoji: "❄️" },
  27: { description: "Heavy snow", emoji: "❄️" },
  28: { description: "Thunder shower", emoji: "⛈️" },
  29: { description: "Thunder shower", emoji: "⛈️" },
  30: { description: "Thunder", emoji: "⛈️" },
};

// The free tier allows 360 calls/day; one forecast covers the whole week, so
// refetching every 30 minutes stays comfortably inside that.
let cache: { at: number; days: Record<string, DayWeather> } | null = null;
const CACHE_TTL_MS = 30 * 60_000;

// Usual run start: midday on weekdays, 10:00 at the weekend.
function runHourFor(date: Date): number {
  const dow = date.getDay();
  return dow === 0 || dow === 6 ? 10 : 12;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const config = loadMetOfficeConfig();
  if (!config) return NextResponse.json({ days: {}, configured: false });

  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return NextResponse.json({ days: cache.days, configured: true });
  }

  try {
    const url = `https://data.hub.api.metoffice.gov.uk/sitespecific/v0/point/three-hourly?latitude=${config.lat}&longitude=${config.lon}`;
    const res = await fetch(url, { headers: { apikey: config.apiKey }, cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json({ error: `Met Office API ${res.status}`, days: {}, configured: true }, { status: 502 });
    }
    const data = await res.json() as {
      features?: { properties?: { timeSeries?: TimeStep[] } }[];
    };
    const steps = data.features?.[0]?.properties?.timeSeries ?? [];

    // For each date in the series, pick the step closest to that day's run
    // hour (in the server's local time — the Pi runs on Europe/London).
    const days: Record<string, DayWeather> = {};
    const byDate = new Map<string, TimeStep[]>();
    for (const s of steps) {
      const local = new Date(s.time);
      const key = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key)!.push(s);
    }
    for (const [date, daySteps] of Array.from(byDate.entries())) {
      const target = runHourFor(new Date(`${date}T12:00:00`));
      let best: TimeStep | null = null;
      let bestDelta = Infinity;
      for (const s of daySteps) {
        const local = new Date(s.time);
        const delta = Math.abs(local.getHours() + local.getMinutes() / 60 - target);
        if (delta < bestDelta) { bestDelta = delta; best = s; }
      }
      // Don't report a "run time" forecast from a step hours away (e.g. the
      // tail end of today when the run hour has already passed).
      if (!best || bestDelta > 1.6) continue;
      const code = best.significantWeatherCode ?? -1;
      const meta = WEATHER_CODES[code] ?? { description: "", emoji: "🌡️" };
      const localBest = new Date(best.time);
      days[date] = {
        tempC: Math.round(best.maxScreenAirTemp ?? 0),
        feelsLikeC: Math.round(best.feelsLikeTemp ?? 0),
        precipProb: best.probOfPrecipitation ?? 0,
        windMph: Math.round((best.windSpeed10m ?? 0) * 2.23694),
        code,
        description: meta.description,
        emoji: meta.emoji,
        sampledAt: `${String(localBest.getHours()).padStart(2, "0")}:${String(localBest.getMinutes()).padStart(2, "0")}`,
      };
    }

    cache = { at: Date.now(), days };
    return NextResponse.json({ days, configured: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Weather fetch failed", days: {}, configured: true }, { status: 502 });
  }
}
