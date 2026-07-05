import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { buildAiDjMix } from "@/lib/ai-dj-mix";

// SSE: streams {"type":"progress","current","total","segment"} as each
// workout segment builds, then {"type":"done",...mix} or {"type":"error"}.
// The mix build is a long blocking call (remote LLM service or on-Pi
// fallback), so a plain JSON response left the UI with no progress signal.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { title, segments } = await req.json() as { title: string; segments: string[] };
  if (!segments?.length) {
    return NextResponse.json({ error: "segments required" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      try {
        // Padding comment flushes past browsers' 1 KB SSE buffer
        controller.enqueue(encoder.encode(`: ${"x".repeat(1024)}\n\n`));

        const result = await buildAiDjMix(title, segments, (current, total, segment) => {
          send({ type: "progress", current, total, segment });
        });
        if (!result.ok) {
          console.error(`[ai-dj] ${result.error}`);
          send({ type: "error", error: result.error });
        } else {
          console.log(`[ai-dj] "${title}": ${result.mix.trackUris.length} tracks, ${Math.round(result.mix.totalSec / 60)} min`);
          send({ type: "done", ...result.mix });
        }
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : "Mix failed" });
      } finally {
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
