import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listOllamaModels, transcribeRaceSplitsImage } from "@/lib/ai-dj-mix";
import { loadAiDjConfig } from "@/lib/ai-dj-config";

// Transcribes a pasted/uploaded race-splits table screenshot (Runna
// schedule card's race workouts) into tab-separated text via the AI DJ
// service's configured Ollama model — same OCR pathway as Settings > Pace
// Pro's screenshot upload, but keeps all 6 columns (elevation + cumulative
// included) since the race card's own paste box needs them, unlike Pace
// Pro's simpler distance/pace-only shape.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { imageBase64 } = await req.json() as { imageBase64?: string };
  if (!imageBase64) {
    return NextResponse.json({ error: "imageBase64 required" }, { status: 400 });
  }

  const config = loadAiDjConfig();
  const configuredModel = config?.ollamaModel;
  if (configuredModel) {
    const modelsResult = await listOllamaModels();
    if (modelsResult.ok) {
      const match = modelsResult.models.find(m => m.name === configuredModel);
      if (match && !match.capabilities.includes("vision")) {
        return NextResponse.json({
          error: `The configured local model ("${configuredModel}") doesn't support image input. `
            + `Switch to a vision-capable model in Settings → Integrations → AI DJ → Local LLM (e.g. qwen3.5:9b) to use screenshot upload.`,
        }, { status: 422 });
      }
    }
  }

  const result = await transcribeRaceSplitsImage(imageBase64);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
  return NextResponse.json({ text: result.text });
}
