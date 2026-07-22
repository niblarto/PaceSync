import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { buildAiDjMix } from "@/lib/ai-dj-mix";
import { healActiveCsv, scanActiveCsv } from "@/lib/csv-heal";
import { getRecentBuildUris, recordMixBuild } from "@/lib/recent-mix-builds";

// SSE: streams {"type":"progress","current","total","segment"} as each
// workout segment builds, then {"type":"done",...mix} or {"type":"error"}.
// The mix build is a long blocking call (remote LLM service or on-Pi
// fallback), so a plain JSON response left the UI with no progress signal.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { title, segments, avoidUris, date } = await req.json() as { title: string; segments: string[]; avoidUris?: string[]; date?: string };
  if (!segments?.length) {
    return NextResponse.json({ error: "segments required" }, { status: 400 });
  }
  // Merge in every recent build's tracks for this date — survives a page
  // reload mid-remix-chain, and gives the overnight cron (no client state
  // of its own) a memory of its own most recent attempt.
  const mergedAvoidUris = date
    ? Array.from(new Set([...(avoidUris ?? []), ...getRecentBuildUris(date)]))
    : avoidUris;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      // Heartbeat comments keep the browser connection alive through any
      // proxy/tunnel idle timeout (~90-100s) while a segment builds silently.
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: hb\n\n`)); } catch { /* stream closed */ }
      }, 15000);
      try {
        // Padding comment flushes past browsers' 1 KB SSE buffer
        controller.enqueue(encoder.encode(`: ${"x".repeat(1024)}\n\n`));

        // Library rows missing data (Duration/Tempo/…) get excluded from the
        // mix pool — try to heal them first, then warn about whatever's left
        // so incomplete tracks never disappear silently.
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
          console.warn("[ai-dj] pre-mix CSV scan failed:", e); // never block the mix
        }

        const result = await buildAiDjMix(title, segments, (current, total, segment, detail) => {
          send({ type: "progress", current, total, segment, detail });
        }, mergedAvoidUris);
        if (!result.ok) {
          console.error(`[ai-dj] ${result.error}`);
          send({ type: "error", error: result.error });
        } else {
          console.log(`[ai-dj] "${title}": ${result.mix.trackUris.length} tracks, ${Math.round(result.mix.totalSec / 60)} min`);
          // Segments where the LLM call failed (rate limit, quota, network)
          // and fell back to the deterministic distance-chain — surface
          // this instead of silently shipping a lesser mix.
          if (result.mix.llmFailures?.length) {
            console.warn(`[ai-dj] ${result.mix.llmFailures.length} segment(s) fell back from LLM selection:`, result.mix.llmFailures);
            send({ type: "warning", llmFailures: result.mix.llmFailures });
          }
          if (date) recordMixBuild(date, result.mix.trackUris);
          send({ type: "done", ...result.mix });
        }
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : "Mix failed" });
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
