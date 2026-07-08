"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

interface StravaActivity {
  id: number;
  name: string;
  sport_type: string;
  start_date_local: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  total_elevation_gain: number;
  average_speed: number;
  max_speed: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_cadence?: number;
  kudos_count: number;
  achievement_count: number;
  pr_count: number;
}

interface StravaAthlete {
  firstname: string;
  lastname: string;
  city: string | null;
  state: string | null;
  country: string | null;
  profile: string | null;
}

interface StravaZones {
  heart_rate: { custom_zones: boolean; zones: { min: number; max: number }[] };
}

interface StatsResponse {
  connected: boolean;
  athlete?: StravaAthlete;
  zones?: StravaZones | null;
  activities?: StravaActivity[];
  error?: string;
}

function metersToMiles(m: number): number {
  return m / 1609.34;
}

function fmtDist(meters: number): string {
  return `${metersToMiles(meters).toFixed(2)} mi`;
}

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtPace(metersPerSec: number): string {
  if (!metersPerSec) return "—";
  const secPerMile = 1609.34 / metersPerSec;
  const m = Math.floor(secPerMile / 60);
  const s = Math.round(secPerMile % 60);
  return `${m}:${String(s).padStart(2, "0")} /mi`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

const SPORT_ICON: Record<string, string> = {
  Run: "🏃",
  Ride: "🚴",
  Swim: "🏊",
  Walk: "🚶",
  Hike: "🥾",
  WeightTraining: "🏋️",
  Workout: "💪",
};

export function StravaClient() {
  const searchParams = useSearchParams();
  const [data, setData] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  function load() {
    setLoading(true);
    fetch("/api/strava/stats")
      .then(r => r.json())
      .then((d: StatsResponse) => { setData(d); setError(d.error ?? null); })
      .catch(() => setError("Failed to load Strava data"))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  const connectedParam = searchParams.get("connected");
  const errorParam = searchParams.get("error");

  async function disconnect() {
    setDisconnecting(true);
    try {
      await fetch("/api/strava/stats", { method: "DELETE" });
      load();
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-white/5 bg-slate-950/70 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link href="/dashboard" className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
            ← Dashboard
          </Link>
          <span className="font-bold text-orange-400 text-lg tracking-tight">Strava Stats</span>
          <Link href="/settings" className="text-xs text-slate-500 hover:text-slate-300 transition-colors">
            Settings
          </Link>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {connectedParam && (
          <div className="rounded-xl bg-green-500/10 border border-green-500/30 text-green-300 text-sm px-4 py-3">
            Connected to Strava.
          </div>
        )}
        {errorParam && (
          <div className="rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-sm px-4 py-3">
            Strava connection failed ({errorParam}). Check your Client ID/Secret in Settings and try again.
          </div>
        )}

        {loading && <p className="text-sm text-slate-500">Loading…</p>}

        {!loading && data && !data.connected && (
          <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-8 text-center space-y-4">
            <p className="text-slate-400">Not connected to Strava.</p>
            <a
              href="/api/strava/connect"
              className="inline-block rounded-lg bg-orange-600 hover:bg-orange-500 text-white font-medium text-sm px-5 py-2 transition-colors"
            >
              Connect Strava →
            </a>
            <p className="text-xs text-slate-600">
              Requires a Strava API app Client ID/Secret — set these first in{" "}
              <Link href="/settings" className="underline hover:text-slate-400">Settings</Link>.
            </p>
          </div>
        )}

        {!loading && error && data?.connected !== false && (
          <p className="text-sm text-red-400">{error}</p>
        )}

        {!loading && data?.connected && (
          <>
            <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 flex items-center justify-between">
              <div className="flex items-center gap-3">
                {data.athlete?.profile && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={data.athlete.profile} alt="" className="h-12 w-12 rounded-full" />
                )}
                <div>
                  <p className="font-semibold">{data.athlete?.firstname} {data.athlete?.lastname}</p>
                  <p className="text-xs text-slate-500">
                    {[data.athlete?.city, data.athlete?.state, data.athlete?.country].filter(Boolean).join(", ") || "—"}
                  </p>
                </div>
              </div>
              <button
                onClick={disconnect}
                disabled={disconnecting}
                className="text-xs text-slate-500 hover:text-red-400 disabled:opacity-40 transition-colors"
              >
                {disconnecting ? "Disconnecting…" : "Disconnect"}
              </button>
            </div>

            {data.zones?.heart_rate?.zones?.length ? (
              <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 overflow-hidden">
                <div className="px-5 py-4 border-b border-white/10">
                  <h2 className="font-semibold">Heart Rate Zones</h2>
                </div>
                <div className="p-4 grid grid-cols-5 gap-2">
                  {data.zones.heart_rate.zones.map((z, i) => (
                    <div key={i} className="rounded-lg bg-slate-800/50 border border-white/5 px-2 py-2.5 text-center">
                      <p className="text-[11px] text-slate-500">Z{i + 1}</p>
                      <p className="text-sm font-mono font-medium">
                        {z.min}{z.max > 0 ? `–${z.max}` : "+"}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 overflow-hidden">
              <div className="px-5 py-4 border-b border-white/10">
                <h2 className="font-semibold">Recent Activities</h2>
                <p className="text-xs text-slate-500 mt-0.5">Last {data.activities?.length ?? 0} activities</p>
              </div>
              <div className="divide-y divide-white/10">
                {(data.activities ?? []).map(a => (
                  <div key={a.id} className="px-5 py-3 flex items-center gap-3">
                    <span className="text-base shrink-0">{SPORT_ICON[a.sport_type] ?? "🏅"}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{a.name}</p>
                      <p className="text-xs text-slate-500">{fmtDate(a.start_date_local)}</p>
                    </div>
                    <div className="text-right shrink-0 text-xs text-slate-400 tabular-nums space-y-0.5">
                      <p>{fmtDist(a.distance)} · {fmtDuration(a.moving_time)}</p>
                      <p className="text-slate-600">
                        {a.sport_type === "Run" ? fmtPace(a.average_speed) : `${(a.average_speed * 3.6).toFixed(1)} km/h`}
                        {a.average_heartrate ? ` · ${Math.round(a.average_heartrate)} bpm` : ""}
                      </p>
                    </div>
                  </div>
                ))}
                {(data.activities?.length ?? 0) === 0 && (
                  <p className="px-5 py-4 text-sm text-slate-500">No activities found.</p>
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
