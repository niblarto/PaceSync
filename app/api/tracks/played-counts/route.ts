import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getPlayCounts } from "@/lib/play-counts";

// How many confirmed runs each track has actually been played on — a
// durable ledger (lib/play-counts.ts) credited only when a workout's
// playlist is explicitly confirmed ("Yes, I ran to this"), so later
// deletions, mix rebuilds, or history pruning never alter past counts.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json({ counts: getPlayCounts() });
}
