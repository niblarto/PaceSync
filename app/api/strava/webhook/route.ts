import { NextRequest, NextResponse } from "next/server";
import { loadStravaConfig } from "@/lib/strava-config";
import { syncWorkoutToStravaActivity } from "@/lib/strava-workout-sync";

// Strava's push subscription callback. Not gated by getServerSession — Strava
// calls this directly with no session cookie; the GET handshake is protected
// by the verify token (set once when subscribing) and the POST body only
// ever triggers a read-then-update of Strava's own data for an activity ID
// Strava itself just told us about.

// One-time subscription verification: Strava GETs this with a challenge
// token and expects it echoed back, but only if our verify_token matches.
export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get("hub.mode");
  const token = req.nextUrl.searchParams.get("hub.verify_token");
  const challenge = req.nextUrl.searchParams.get("hub.challenge");

  const config = loadStravaConfig();
  if (mode !== "subscribe" || !config?.webhookVerifyToken || token !== config.webhookVerifyToken) {
    return NextResponse.json({ error: "verification failed" }, { status: 403 });
  }
  return NextResponse.json({ "hub.challenge": challenge });
}

interface StravaWebhookEvent {
  object_type: "activity" | "athlete";
  object_id: number;
  aspect_type: "create" | "update" | "delete";
  updates?: Record<string, string>;
}

// Strava expects a 200 within 2 seconds — do the actual Strava API calls
// (fetch + update the activity) after responding, not before.
export async function POST(req: NextRequest) {
  let event: StravaWebhookEvent;
  try {
    event = await req.json() as StravaWebhookEvent;
  } catch {
    return NextResponse.json({ ok: true }); // malformed body — ack anyway, nothing to retry
  }

  if (event.object_type === "activity" && event.aspect_type === "create") {
    syncWorkoutToStravaActivity(event.object_id)
      .then(result => {
        if (!result.ok) console.warn(`[strava/webhook] sync failed for activity ${event.object_id}: ${result.error}`);
        else if (result.updated) console.log(`[strava/webhook] updated activity ${event.object_id} with "${result.workoutTitle}"`);
        else console.log(`[strava/webhook] no update for activity ${event.object_id}: ${result.reason}`);
      })
      .catch(e => console.warn(`[strava/webhook] sync threw for activity ${event.object_id}:`, e));
  }

  return NextResponse.json({ ok: true });
}
