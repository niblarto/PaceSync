import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listOllamaModels } from "@/lib/ai-dj-mix";

// Lists installed Ollama models on the remote AI DJ service host, for the
// Settings -> LLM Testing tab's model checklist.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const result = await listOllamaModels();
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
  return NextResponse.json({ models: result.models });
}
