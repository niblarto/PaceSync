import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { SignInButton } from "@/components/SignInButton";

export default async function HomePage() {
  const session = await getServerSession(authOptions);
  if (session) redirect("/dashboard");

  return (
    <main className="min-h-screen flex flex-col">
      {/* Hero */}
      <div className="relative flex-1 flex flex-col items-center justify-center px-4 text-center py-24 overflow-hidden">
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
          <div className="mb-6 inline-flex items-center gap-2 rounded-full bg-green-500/10 px-4 py-1.5 text-sm font-medium text-green-400 ring-1 ring-green-500/20">
            <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
            Built for runners
          </div>

          <h1 className="text-5xl sm:text-6xl font-bold tracking-tight mb-6 max-w-3xl drop-shadow-lg">
            Music that matches
            <span className="text-green-400"> your pace</span>
          </h1>

          <p className="text-slate-300 text-lg max-w-xl mb-10 leading-relaxed drop-shadow">
            Filter your Spotify playlists by BPM across your heart rate zones —
            so your music always matches your effort.
          </p>

          <SignInButton />
        </div>
      </div>

      {/* Feature grid — below the hero */}
      <div className="bg-slate-950 px-4 pb-20 pt-12">
        <div className="mx-auto grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-3xl text-left">
          {[
            {
              icon: "❤️",
              title: "Heart rate zones",
              body: "Manually configure your personal HR zones for accurate BPM matching.",
            },
            {
              icon: "🎵",
              title: "BPM-matched tracks",
              body: "Scans every song in your playlists via Spotify's audio analysis API.",
            },
            {
              icon: "📅",
              title: "Runna workouts",
              body: "Pulls your scheduled Runna training sessions and suggests the right zone for each.",
            },
          ].map((f) => (
            <div
              key={f.title}
              className="rounded-xl bg-slate-900 border border-slate-800 p-5"
            >
              <div className="text-2xl mb-3">{f.icon}</div>
              <h3 className="font-semibold mb-1">{f.title}</h3>
              <p className="text-slate-400 text-sm leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
      </div>

      <footer className="bg-slate-950 text-center text-slate-600 text-sm py-6 border-t border-slate-900">
        PaceSync — not affiliated with Spotify
      </footer>
    </main>
  );
}
