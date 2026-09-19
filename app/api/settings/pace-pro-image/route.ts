import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listOllamaModels, transcribePaceProImage } from "@/lib/ai-dj-mix";
import { loadAiDjConfig } from "@/lib/ai-dj-config";

// Transcribes a pasted/uploaded PacePro split-table screenshot into CSV
// text via the AI DJ service's configured Ollama model — Settings -> Pace
// Pro's "paste a screenshot" path. Checks the configured model's vision
// capability here (not just server-side) so a clear, specific error comes
// back instead of the model call failing opaquely.
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
    // If the model list itself couldn't be fetched, fall through and let
    // the actual transcribe call surface whatever error occurs — better
    // than blocking the feature on a capability check that couldn't run.
  }

  const result = await transcribePaceProImage(imageBase64);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
  return NextResponse.json({ csv: result.csv });
}
