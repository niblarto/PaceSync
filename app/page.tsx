import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { SignInButton } from "@/components/SignInButton";

export default async function HomePage() {
  const session = await getServerSession(authOptions);
  if (session) redirect("/dashboard");

  return (
    <main className="h-screen flex flex-col overflow-hidden">
      {/* Top bar — sign-in stays reachable even if the hero/feature grid
          below runs taller than the viewport (e.g. small mobile screens),
          instead of being buried inside the hero where it could scroll
          out of view. */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 bg-slate-950 border-b border-slate-900">
        <span className="font-semibold text-sm">PaceSync</span>
        <SignInButton compact />
      </div>

      {/* Hero */}
      <div className="relative flex-1 min-h-0 flex flex-col items-center justify-center px-4 text-center py-6 overflow-hidden">
        {/* Background image */}
        <div
          className="absolute inset-0 bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: "url('/hero.png')" }}
        />
        {/* Gradient overlays — darken edges, keep centre readable */}
        <div className="absolute inset-0 bg-gradient-to-b from-slate-950/80 via-slate-950/40 to-slate-950/90" />
        <div className="absolute inset-0 bg-gradient-to-r from-slate-950/60 via-transparent to-slate-950/60" />

        {/* Content */}
        <div className="relative z-10 flex flex-col items-center">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-green-500/10 px-4 py-1.5 text-sm font-medium text-green-400 ring-1 ring-green-500/20">
            <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
            Built for runners
          </div>

          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4 max-w-3xl drop-shadow-lg">
            Music that matches
            <span className="text-green-400"> your pace</span>
          </h1>

          <p className="text-slate-300 text-base max-w-xl mb-6 leading-relaxed drop-shadow">
            Filter your Spotify playlists by BPM across your heart rate zones —
            so your music always matches your effort.
          </p>
        </div>
      </div>

      {/* Feature grid — below the hero */}
      <div className="bg-slate-950 px-4 py-5 shrink-0">
        <div className="mx-auto grid grid-cols-2 sm:grid-cols-3 gap-3 max-w-4xl text-left">
          {[
            {
              icon: "❤️",
              title: "Heart rate zones",
              body: "Manually configure your personal HR zones for accurate BPM matching.",
            },
            {
              icon: "🎵",
              title: "BPM-matched tracks",
              body: "Filter your playlist by tempo — missing BPM data is filled in automatically.",
            },
            {
              icon: "📅",
              title: "Runna workouts",
              body: "Your training schedule with zone suggestions and one-tap BPM filters for each session pace.",
            },
            {
              icon: "🎧",
              title: "AI DJ Mix",
              body: "Auto-build a pace-matched playlist for any Runna workout, powered by Claude, Gemini, or a local LLM.",
            },
            {
              icon: "📻",
              title: "BBC Radio",
              body: "Pull tracklists from BBC radio shows straight into your playlist, refreshed automatically every week.",
            },
            {
              icon: "✨",
              title: "Song discovery",
              body: "Find new songs matching any track by style or tempo, and add them straight to your playlist.",
            },
            {
              icon: "🔍",
              title: "Song matching",
              body: "Filter to songs like any track using BPM, musical key, energy and danceability.",
            },
            {
              icon: "⌚",
              title: "Garmin insights",
              body: "Pace, cadence and heart rate charts from your own runs — powering pace-to-BPM lookups.",
            },
            {
              icon: "🟠",
              title: "Strava sync",
              body: "Auto-tag Strava activities with your Runna workout details, and browse recent runs and zones.",
            },
          ].map((f) => (
            <div
              key={f.title}
              className="rounded-lg bg-slate-900 border border-slate-800 px-4 py-3"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-lg">{f.icon}</span>
                <h3 className="font-semibold text-sm">{f.title}</h3>
              </div>
              <p className="text-slate-400 text-xs leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
      </div>

      <footer className="bg-slate-950 text-center text-slate-600 text-xs py-2.5 border-t border-slate-900 shrink-0">
        PaceSync — not affiliated with Spotify · BPM data via{" "}
        <a href="https://reccobeats.com" target="_blank" rel="noopener noreferrer" className="hover:text-slate-400 underline underline-offset-2 transition-colors">
          ReccoBeats
        </a>
        {" "}and{" "}
        <a href="https://www.deezer.com" target="_blank" rel="noopener noreferrer" className="hover:text-slate-400 underline underline-offset-2 transition-colors">
          Deezer
        </a>
      </footer>
    </main>
  );
}
