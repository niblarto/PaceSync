import { sendNtfy } from "@/lib/ntfy";
import { sendPush } from "@/lib/push";

// One call for every scheduled job's result: the ntfy notification it has
// always sent, plus a push to the Android app. Push bodies are capped — FCM
// notifications have a small payload limit and the app shows them as a
// notification, not a document (long track lists get trimmed).
export interface CronNotifyOptions {
  title: string;
  /** ntfy tags, e.g. "x" or "musical_note,white_check_mark". */
  tags?: string;
  priority?: "high" | "default" | "low";
  /** Android channel: "bbc" | "ai-dj" | "sync-error" | "digest" | anything else -> General. */
  type: string;
}

const PUSH_BODY_MAX = 1500;

export async function cronNotify(message: string, options: CronNotifyOptions): Promise<void> {
  const body = message.length > PUSH_BODY_MAX ? `${message.slice(0, PUSH_BODY_MAX - 1)}…` : message;
  await Promise.all([
    sendNtfy(message, { title: options.title, tags: options.tags, priority: options.priority }).catch(() => false),
    sendPush(body, { title: options.title, priority: options.priority, type: options.type }).catch(() => false),
  ]);
}
