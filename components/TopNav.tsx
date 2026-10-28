"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { signOut, useSession } from "next-auth/react";
import { SongProgressBar } from "@/components/SongProgressBar";

const NAV_LINK = "text-xs text-slate-500 hover:text-slate-300 transition-colors whitespace-nowrap";
const FALLBACK_AVATAR = "data:image/svg+xml;utf8," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#334155"/></svg>',
);

// The links of the top menu (Settings is last; the Settings page itself doesn't use this bar).
const LINKS: { href: string; label: string; needsGarmin?: boolean }[] = [
  { href: "/garmin", label: "Garmin", needsGarmin: true },
  { href: "/coach", label: "Coach" },
  { href: "/nutrition", label: "Nutrition" },
  { href: "/crawler", label: "Crawler" },
  { href: "/pace-pro", label: "Pace Pro" },
  { href: "/races", label: "Races" },
  { href: "/routes", label: "Routes" },
  { href: "/strava", label: "Strava" },
  { href: "/bbc", label: "BBC Radio" },
  { href: "/settings", label: "Settings" },
];

// The top menu shared by the pages the dashboard links to: a link back to the dashboard, the title of the
// page you're on, the music seek bar, and the menu. `extra` is an optional slim row under the bar for a
// page's own status line.
export function TopNav({ title, extra, maxWidth = "max-w-[1800px]" }: { title: string; extra?: ReactNode; maxWidth?: string }) {
  const { data: session } = useSession();
  const [garminConfigured, setGarminConfigured] = useState(false);
  useEffect(() => {
    fetch("/api/settings/garmin")
      .then(r => r.json())
      .then((d: { configured?: boolean }) => setGarminConfigured(d.configured ?? false))
      .catch(() => {});
  }, []);

  return (
    <header className="border-b border-white/5 bg-slate-950/70 backdrop-blur-md sticky top-0 z-20">
      <div className={`${maxWidth} mx-auto px-4 h-14 flex items-center gap-4`}>
        <Link href="/dashboard" className="text-sm text-slate-400 hover:text-slate-200 transition-colors whitespace-nowrap shrink-0">← Dashboard</Link>
        <span className="font-bold text-green-400 text-lg tracking-tight whitespace-nowrap shrink-0">{title}</span>
        <SongProgressBar className="flex-1 min-w-0 max-w-md mx-2" />
        <nav className="ml-auto flex items-center gap-4 shrink-0">
          {session?.user && (
            <div className="flex items-center gap-2 text-sm text-slate-400">
              {session.user.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={session.user.image} alt="" className="h-7 w-7 rounded-full"
                  onError={e => { (e.target as HTMLImageElement).src = FALLBACK_AVATAR; }} />
              )}
              <span>{session.user.name}</span>
            </div>
          )}
          {LINKS.filter(l => !l.needsGarmin || garminConfigured).map(l => (
            <Link key={l.href} href={l.href} className={NAV_LINK}>{l.label}</Link>
          ))}
          <button
            onClick={async () => {
              await fetch("/api/local-auth/logout", { method: "POST" }).catch(() => {});
              signOut({ callbackUrl: "/" });
            }}
            className={NAV_LINK}
          >
            Sign out
          </button>
        </nav>
      </div>
      {extra && (
        <div className={`${maxWidth} mx-auto px-4 py-1.5 border-t border-white/5 flex items-center justify-end gap-3`}>{extra}</div>
      )}
    </header>
  );
}
