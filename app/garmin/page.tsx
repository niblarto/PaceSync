import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { loadGarminConfig } from "@/lib/garmin-config";
import { GarminClient } from "@/components/GarminClient";
import Link from "next/link";

export default async function GarminPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");

  const config = loadGarminConfig();

  if (!config) {
    return (
      <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
        <header className="border-b border-white/5 bg-slate-950/70 backdrop-blur-md sticky top-0 z-10">
          <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
            <Link href="/dashboard" className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
              ← Dashboard
            </Link>
            <span className="font-bold text-green-400 text-lg tracking-tight">Garmin Stats</span>
            <div />
          </div>
        </header>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-4">
            <p className="text-slate-400 text-lg">Garmin DB not configured.</p>
            <Link
              href="/settings"
              className="inline-block rounded-lg bg-green-600 hover:bg-green-500 text-white font-medium text-sm px-5 py-2 transition-colors"
            >
              Configure in Settings →
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return <GarminClient />;
}
