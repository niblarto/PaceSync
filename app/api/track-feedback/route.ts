import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getAllTrackVotes, setTrackVote } from "@/lib/track-feedback";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ votes: getAllTrackVotes() });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { uri, paceSec, vote } = await req.json() as {
    uri?: string;
    paceSec?: number;
    vote?: "up" | "down" | null;
  };
  if (!uri || typeof paceSec !== "number" || paceSec <= 0 || (vote != null && vote !== "up" && vote !== "down")) {
    return NextResponse.json({ error: "uri, paceSec and vote (up/down/null) required" }, { status: 400 });
  }
  return NextResponse.json({ votes: setTrackVote(uri, paceSec, vote ?? null) });
}
