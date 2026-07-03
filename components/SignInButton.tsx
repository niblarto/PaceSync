"use client";

import Link from "next/link";

export function SignInButton() {
  return (
    <Link
      href="/login"
      className="inline-flex items-center gap-3 rounded-full bg-green-500 hover:bg-green-400 active:bg-green-600 px-8 py-3.5 text-base font-semibold text-black transition-colors"
    >
      <span className="text-xl leading-none">🏃</span>
      Sign in
    </Link>
  );
}
