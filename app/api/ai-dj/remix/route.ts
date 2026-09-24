import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { buildAiDjRemix } from "@/lib/ai-dj-mix";

// SSE: Dashboard chart's multi-select "🤖 AI Remix…" — streams
// {"type":"progress",...} while the LLM picks tracks, then {"type":"done",
// trackUris} (the single segment's tracks, in the order the mixer chose)
// or {"type":"error"}. Same shape as /api/ai-dj/mix, just for one synthetic
// BPM+duration segment instead of a whole workout's worth.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { targetBpm, budgetMs, avoidUris } = await req.json() as {
    targetBpm?: number; budgetMs?: number; avoidUris?: string[];
  };
  if (!targetBpm || targetBpm <= 0) return NextResponse.json({ error: "targetBpm required" }, { status: 400 });
  if (!budgetMs || budgetMs <= 0) return NextResponse.json({ error: "budgetMs required" }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: hb\n\n`)); } catch { /* stream closed */ }
      }, 15000);
      try {
        controller.enqueue(encoder.encode(`: ${"x".repeat(1024)}\n\n`));

        const result = await buildAiDjRemix(targetBpm, budgetMs, avoidUris ?? [], (current, total, segment, detail) => {
          send({ type: "progress", current, total, segment, detail });
        });
        if (!result.ok) {
          send({ type: "error", error: result.error });
        } else {
          if (result.mix.llmFailures?.length) {
            send({ type: "warning", error: `AI DJ fell back to BPM matching: ${result.mix.llmFailures[0]}` });
          }
          send({ type: "done", trackUris: result.mix.trackUris, timeline: result.mix.timeline });
        }
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : "AI Remix failed" });
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
