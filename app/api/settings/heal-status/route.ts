import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getHealProgress } from "@/lib/csv-heal";

// Polled by Settings while a CSV heal sweep (BPM/audio-feature backfill) is
// running, so a large-library import doesn't look silently hung — see
// lib/csv-heal.ts's writeProgress calls.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ progress: await getHealProgress() });
}
