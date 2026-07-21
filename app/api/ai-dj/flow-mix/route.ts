import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { buildAiDjFlowMix } from "@/lib/ai-dj-mix";
import { healActiveCsv, scanActiveCsv } from "@/lib/csv-heal";

// SSE variant of /api/ai-dj/mix, but for a fixed track pool (e.g. every
// track in a selected HR zone) instead of workout segments — the AI DJ just
// sequences the given tracks for smooth transitions.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { title, trackUris, durationSec } = await req.json() as { title: string; trackUris: string[]; durationSec?: number };
  if (!trackUris?.length) {
    return NextResponse.json({ error: "trackUris required" }, { status: 400 });
  }

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

        try {
          if ((await scanActiveCsv()).incomplete.length > 0) {
            send({ type: "progress", current: 0, total: 1, segment: "Fixing missing track data…" });
            await healActiveCsv();
            const { incomplete } = await scanActiveCsv();
            if (incomplete.length > 0) {
              console.warn(`[ai-dj] ${incomplete.length} tracks still missing data after heal`);
              send({
                type: "warning",
                count: incomplete.length,
                tracks: incomplete.slice(0, 8).map(t => `${t.name}${t.artist ? ` — ${t.artist}` : ""}`),
                uris: incomplete.map(t => t.uri),
                fields: Array.from(new Set(incomplete.flatMap(t => t.missing))),
              });
            }
          }
        } catch (e) {
          console.warn("[ai-dj] pre-mix CSV scan failed:", e);
        }

        const result = await buildAiDjFlowMix(title, trackUris, (current, total, segment, detail) => {
          send({ type: "progress", current, total, segment, detail });
        }, durationSec);
        if (!result.ok) {
          console.error(`[ai-dj] ${result.error}`);
          send({ type: "error", error: result.error });
        } else {
          console.log(`[ai-dj] flow-mix "${title}": ${result.mix.trackUris.length} tracks, ${Math.round(result.mix.totalSec / 60)} min`);
          if (result.mix.llmFailures?.length) {
            send({ type: "warning", llmFailures: result.mix.llmFailures });
          }
          send({ type: "done", ...result.mix });
        }
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : "Flow mix failed" });
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
