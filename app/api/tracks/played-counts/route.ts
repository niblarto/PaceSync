import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getPlayedCounts } from "@/lib/todays-run-history";

// How many confirmed "Today's Run" mixes each track has featured in —
// shown next to the artist name in the main track list.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json({ counts: getPlayedCounts() });
}
