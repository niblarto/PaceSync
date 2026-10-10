import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { loadFcmToken } from "@/lib/fcm-config";

// Firebase Cloud Messaging publisher for the Android companion app —
// mirrors lib/ntfy.ts's sendNtfy() call shape so migrating each call site
// is a near-identical function swap. During the rollout both sendNtfy and
// sendPush are called side by side at each site (a short soak window) before
// ntfy is retired — see the Android companion app plan for the full
// call-site inventory and migration order.
export interface PushOptions {
  title?: string;
  priority?: string; // "high" | "default" | ...
  // Discriminator the app's FirebaseMessagingService uses to route the
  // notification to the matching Android Notification Channel (bbc, ai-dj,
  // sync-error, digest, or a general fallback). Doesn't map 1:1 from ntfy's
  // free-form "tags" string, so call sites set it explicitly on migration.
  type?: string;
}

function getFirebaseApp() {
  const existing = getApps();
  if (existing.length) return existing[0];
  const credJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!credJson) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON not set");
  return initializeApp({ credential: cert(JSON.parse(credJson)) });
}

export async function sendPush(message: string, options: PushOptions = {}): Promise<boolean> {
  const token = loadFcmToken();
  if (!token) return false;
  try {
    await getMessaging(getFirebaseApp()).send({
      token,
      notification: { title: options.title ?? "PaceSync", body: message },
      data: { type: options.type ?? "general" },
      android: { priority: options.priority === "high" ? "high" : "normal" },
    });
    return true;
  } catch (e) {
    console.warn("[push] send failed:", e);
    return false;
  }
}
