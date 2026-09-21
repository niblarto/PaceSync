import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { fitBudget } from "@/lib/fit-budget";

// "Try and add to mix" button on the Lookup tracks modal's results — takes
// the user's CHECKED matches (already resolved to a real Spotify URI + BPM
// by /api/tracks/lookup-list) and fits them against a chart selection's
// combined duration, using the exact same "fill the gap as near as
// possible" combination search (lib/fit-budget.ts) the multi-select
// Remix… flow already uses — same rule, just choosing from the user's own
// hand-picked pool instead of an artist/genre/BPM online search. No BPM or
// genre filtering here: the user already picked these tracks deliberately,
// so the only job left is choosing which subset best fills the gap.

interface FitCandidate {
  uri: string;
  name: string;
  artist: string;
  tempo: number;
  durationMs: number;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { tracks?: FitCandidate[]; budgetMs?: number };
  const tracks = body.tracks ?? [];
  const budgetMs = body.budgetMs;
  if (tracks.length === 0) return NextResponse.json({ error: "tracks required" }, { status: 400 });
  if (!budgetMs || budgetMs <= 0) return NextResponse.json({ error: "budgetMs required" }, { status: 400 });

  const pool = tracks.filter(t => t.uri && t.durationMs > 0);
  const chosen = fitBudget(pool, budgetMs / 1000);
  const totalMs = chosen.reduce((sum, t) => sum + t.durationMs, 0);

  return NextResponse.json({ tracks: chosen, totalMs, budgetMs, poolSize: pool.length });
}
