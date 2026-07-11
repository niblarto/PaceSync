"use client";

import Link from "next/link";

export function SignInButton({ compact = false }: { compact?: boolean }) {
  return (
    <Link
      href="/login"
      className={
        compact
          ? "inline-flex items-center gap-2 rounded-full bg-green-500 hover:bg-green-400 active:bg-green-600 px-4 py-1.5 text-sm font-semibold text-black transition-colors"
          : "inline-flex items-center gap-3 rounded-full bg-green-500 hover:bg-green-400 active:bg-green-600 px-8 py-3.5 text-base font-semibold text-black transition-colors"
      }
    >
      <span className={compact ? "text-base leading-none" : "text-xl leading-none"}>🏃</span>
      Sign in
    </Link>
  );
}
