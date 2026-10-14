import { NextRequest, NextResponse } from "next/server";
import { cronNotify } from "@/lib/cron-notify";

// Lets scheduled jobs that aren't API routes (the Garmin sync shell
// script) report their result to ntfy + the Android app the same way the
// route-based jobs do. Cron-secret only — called from the Pi itself.
export async function POST(req: NextRequest) {
  if (!process.env.CRON_SECRET || req.headers.get("X-Cron-Secret") !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { title, message, type, tags, priority } = await req.json() as {
    title?: string; message?: string; type?: string; tags?: string; priority?: "high" | "default" | "low";
  };
  if (!title || !message) return NextResponse.json({ error: "title and message required" }, { status: 400 });
  await cronNotify(message, { title, tags, priority, type: type ?? "general" });
  return NextResponse.json({ ok: true });
}
