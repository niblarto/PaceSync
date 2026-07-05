import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { spawn } from "child_process";
import path from "path";
import { activeCsvPath } from "@/lib/running-playlist-config";

// Suggestion search hits Last.fm/Deezer/ReccoBeats and takes 1–2 minutes, so
// this is an SSE stream (progress lines forwarded from the matcher's stderr)
// with an in-process result cache keyed on (uri, mode).

const PYTHON = process.platform === "win32" ? "python" : "python3";
const cache = new Map<string, object>();

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const uri = req.nextUrl.searchParams.get("uri");
  const mode = req.nextUrl.searchParams.get("mode") === "tempo" ? "tempo" : "style";
  const seed = req.nextUrl.searchParams.get("seed"); // JSON features for seeds not in the CSV
  if (!uri) return new Response("Missing uri", { status: 400 });

  const cacheKey = `${uri}:${mode}`;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // Padding comment flushes past browsers' 1 KB SSE buffer
      controller.enqueue(encoder.encode(`: ${"x".repeat(1024)}\n\n`));

      const cached = cache.get(cacheKey);
      if (cached) {
        send({ done: true, result: cached });
        controller.close();
        return;
      }

      const script = path.join(process.cwd(), "scripts", "bpm_bridge.py");
      const csv = activeCsvPath();
      const args = [script, "suggest", csv, uri, mode, "20"];
      if (seed) args.push(seed);
      const proc = spawn(PYTHON, args);

      let stdout = "";
      let stderrTail = "";
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => {
        const text = d.toString();
        stderrTail = (stderrTail + text).slice(-2000);
        for (const line of text.split("\n")) {
          const msg = line.trim();
          if (msg) send({ progress: msg });
        }
      });
      proc.on("close", (code) => {
        if (code !== 0) {
          send({ error: stderrTail.trim().split("\n").pop() || `python exited ${code}` });
        } else {
          try {
            const result = JSON.parse(stdout) as object;
            cache.set(cacheKey, result);
            send({ done: true, result });
          } catch {
            send({ error: "Bad JSON from matcher" });
          }
        }
        controller.close();
      });
      proc.on("error", (err) => {
        send({ error: err.message });
        controller.close();
      });
      req.signal.addEventListener("abort", () => { proc.kill(); });
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
