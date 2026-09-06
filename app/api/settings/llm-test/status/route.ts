import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getOllamaModelStatus } from "@/lib/ai-dj-mix";

// Live GPU/CPU offload for whatever Ollama has loaded right now, polled by
// the LLM Testing tab while a comparison run is in flight.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const result = await getOllamaModelStatus();
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
  return NextResponse.json({ models: result.models });
}
