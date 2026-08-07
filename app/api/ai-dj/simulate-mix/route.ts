import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { simulateAiDjMix } from "@/lib/ai-dj-mix";

type SimKind = "warmup" | "work" | "easy" | "cooldown" | "rest";
// Must each contain one of _is_segment_line's trigger words (ai_dj/workout.py)
// — plain "easy" alone doesn't match; "conversational" does (and is also
// what _segment_kind looks for to classify the line as "easy").
const KIND_LABEL: Record<Exclude<SimKind, "work" | "rest">, string> = {
  warmup: "warm up",
  easy: "conversational",
  cooldown: "cool down",
};

// Diagnostic-only SSE route for the Settings -> BPM "Simulate a mix" card.
// Runs one synthetic single-segment mix through the real production
// pipeline (same _segment_pool/choose_setlist/LLM call a real mix uses) and
// streams back candidate/prompt/response/result events, but — unlike
// /api/ai-dj/mix — never calls recordMixBuild/setMixCandidates, so nothing
// about the run is persisted anywhere except the caller's own in-memory log.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { kind, miles, pace } = await req.json() as { kind: SimKind; miles: number; pace?: string };
  if (!kind || !["warmup", "work", "easy", "cooldown", "rest"].includes(kind)) {
    return NextResponse.json({ error: "kind must be one of warmup, work, easy, cooldown, rest" }, { status: 400 });
  }
  if (!(miles > 0)) {
    return NextResponse.json({ error: "miles must be a positive number" }, { status: 400 });
  }
  if (kind === "work" && !pace?.trim()) {
    return NextResponse.json({ error: "work segments need a pace (e.g. 7:30) — without one it silently downgrades to easy" }, { status: 400 });
  }

  let segment: string;
  if (kind === "rest") {
    // _REST_RE only matches time-based phrasing, not distance — convert
    // miles -> minutes at a plausible easy pace (9:00/mi), floored so the
    // parser's <120s short-rest merge doesn't fold this into nothing.
    const minutes = Math.max(2, Math.round(miles * 9));
    segment = `${minutes} min rest`;
  } else if (kind === "work") {
    segment = `${miles}mi at ${pace}/mi`;
  } else {
    segment = `${miles}mi ${KIND_LABEL[kind]}`;
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

        const result = await simulateAiDjMix(
          segment,
          (current, total, seg, detail, candidateUris) => {
            send({ type: "progress", current, total, segment: seg, detail, candidateUris });
          },
          (event) => {
            send({ type: "llm", ...event });
          },
        );

        if (!result.ok) {
          send({ type: "error", error: result.error });
        } else {
          send({ type: "done", ...result.mix });
        }
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : "Simulation failed" });
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
