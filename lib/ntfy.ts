import { loadNtfyTopic } from "@/lib/ntfy-config";

// Shared ntfy.sh publisher for every automated job. Publishes as JSON, not
// headers: HTTP headers are Latin-1 only, so emoji in a Title header ("🎧 AI
// DJ Mix Ready") makes fetch throw "Cannot convert argument to a ByteString"
// and the notification silently dies — which is exactly how the cron pushes
// were being lost. The JSON publish format is UTF-8 safe.
export interface NtfyOptions {
  title?: string;
  tags?: string;      // comma-separated, e.g. "white_check_mark,musical_note"
  priority?: string;  // "high" | "default" | ...
  topic?: string;     // override the saved topic (used by the settings test)
}

const PRIORITY = { min: 1, low: 2, default: 3, high: 4, max: 5 } as const;

export async function sendNtfy(message: string, options: NtfyOptions = {}): Promise<boolean> {
  const topic = options.topic || loadNtfyTopic() || process.env.NTFY_TOPIC || "";
  if (!topic) return false;
  try {
    const body: Record<string, unknown> = { topic, message };
    if (options.title) body.title = options.title;
    if (options.tags) body.tags = options.tags.split(",").map(t => t.trim()).filter(Boolean);
    if (options.priority) body.priority = PRIORITY[options.priority as keyof typeof PRIORITY] ?? 3;
    const res = await fetch("https://ntfy.sh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.warn(`[ntfy] publish failed: ${res.status}`);
    return res.ok;
  } catch (e) {
    console.warn("[ntfy] publish failed:", e);
    return false;
  }
}
