import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { compareAiDjModels } from "@/lib/ai-dj-mix";

// Streams a side-by-side comparison of the same workout across multiple
// Ollama models — Settings -> LLM Testing tab. Runs models sequentially
// (one uncontended GPU slot at a time) via the real production pipeline;
// nothing here is persisted to Today's Run history or mix_candidates.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { segments, models } = await req.json() as { segments?: string[]; models?: string[] };
  if (!segments?.length) {
    return NextResponse.json({ error: "segments required" }, { status: 400 });
  }
  if (!models?.length) {
    return NextResponse.json({ error: "at least one model required" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch { /* stream already closed */ }
      };
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: hb\n\n`)); } catch { /* stream closed */ }
      }, 15000);
      try {
        // 1KB padding comment — prevents intermediary/proxy gzip buffering
        // from holding the first real event back (see project_sse_progress_bar).
        controller.enqueue(encoder.encode(`: ${"x".repeat(1024)}\n\n`));

        const results = await compareAiDjModels(
          segments, models,
          (model, index, total) => send({ type: "model-start", model, index, total }),
          (current, total, segment, detail) => send({ type: "progress", current, total, segment, detail }),
        );

        send({ type: "done", results });
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : "Comparison failed" });
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Content-Encoding": "none",
    },
  });
}
