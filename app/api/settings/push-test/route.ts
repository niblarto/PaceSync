import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadFcmToken } from "@/lib/fcm-config";
import { sendPush } from "@/lib/push";

// Sends a single test push to whatever device last registered via
// /api/settings/fcm-token — the FCM analog of /api/settings/ntfy's PUT test
// endpoint, surfaced in Settings next to the Mobile App token/digest
// controls so push delivery can be checked without waiting for a real
// cron-triggered notification.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!loadFcmToken()) {
    return NextResponse.json({ error: "No device registered for push yet — open the Android app's Settings tab first." }, { status: 400 });
  }

  const ok = await sendPush(
    `Push notifications are working — sent ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}.`,
    { title: "🎧 PaceSync test notification", type: "test" },
  );
  if (!ok) return NextResponse.json({ error: "Could not send push (check FIREBASE_SERVICE_ACCOUNT_JSON is set)" }, { status: 502 });
  return NextResponse.json({ ok: true });
}
