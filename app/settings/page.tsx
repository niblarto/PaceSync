import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { SettingsClient } from "./SettingsClient";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: { bbc?: string; pid?: string; name?: string };
}) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");

  const bbcMode = searchParams.bbc === "add" || searchParams.bbc === "replace"
    ? searchParams.bbc
    : undefined;

  return (
    <div
      className="min-h-screen flex flex-col bg-cover bg-fixed bg-center bg-no-repeat"
      style={{ backgroundImage: "linear-gradient(rgba(2,6,23,0.65), rgba(2,6,23,0.65)), url('/dashboard-hero.png')" }}
    >
      <header className="border-b border-white/5 bg-slate-950/70 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-[1800px] mx-auto px-4 h-14 flex items-center gap-4">
          <Link
            href="/dashboard"
            className="text-slate-500 hover:text-slate-300 text-sm transition-colors"
          >
            ← Dashboard
          </Link>
          <span className="font-bold text-green-400 text-lg tracking-tight">Settings</span>
        </div>
      </header>
      <div className="max-w-[1800px] mx-auto px-4 py-8 w-full">
        <SettingsClient
          bbcMode={bbcMode}
          bbcReplacePid={searchParams.pid}
          bbcReplaceName={searchParams.name ? decodeURIComponent(searchParams.name) : undefined}
        />
      </div>
    </div>
  );
}
