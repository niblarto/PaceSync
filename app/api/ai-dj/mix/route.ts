import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { buildAiDjMix } from "@/lib/ai-dj-mix";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { title, segments } = await req.json() as { title: string; segments: string[] };
  if (!segments?.length) {
    return NextResponse.json({ error: "segments required" }, { status: 400 });
  }

  const result = await buildAiDjMix(title, segments);
  if (!result.ok) {
    console.error(`[ai-dj] ${result.error}`);
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  console.log(`[ai-dj] "${title}": ${result.mix.trackUris.length} tracks, ${Math.round(result.mix.totalSec / 60)} min`);
  return NextResponse.json(result.mix);
}
