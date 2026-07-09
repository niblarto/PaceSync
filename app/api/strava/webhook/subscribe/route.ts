import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadStravaConfig, updateStravaConfig } from "@/lib/strava-config";
import crypto from "crypto";

// One-time setup: registers PaceSync's webhook with Strava so it's notified
// the moment a new activity is created. Idempotent — Strava allows only one
// active subscription per app, so re-running this after a subscription
// already exists just confirms/returns it rather than erroring.

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const config = loadStravaConfig();
  if (!config) return NextResponse.json({ error: "Strava not configured" }, { status: 400 });

  const base = process.env.NEXTAUTH_URL?.replace(/\/+$/, "");
  if (!base) return NextResponse.json({ error: "NEXTAUTH_URL not set — required for Strava's callback" }, { status: 400 });

  const verifyToken = config.webhookVerifyToken ?? crypto.randomBytes(16).toString("hex");
  if (!config.webhookVerifyToken) updateStravaConfig({ webhookVerifyToken: verifyToken });

  try {
    const res = await fetch("https://www.strava.com/api/v3/push_subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        callback_url: `${base}/api/strava/webhook`,
        verify_token: verifyToken,
      }),
    });
    const data = await res.json() as { id?: number; errors?: unknown };
    if (!res.ok) {
      // Strava returns 400 if a subscription already exists — check first.
      return NextResponse.json({ error: `Strava rejected subscription: ${JSON.stringify(data.errors ?? data)}` }, { status: 502 });
    }
    if (data.id) updateStravaConfig({ webhookSubscriptionId: data.id });
    return NextResponse.json({ ok: true, subscriptionId: data.id });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Subscribe failed" }, { status: 502 });
  }
}

// Stop auto-updates: delete the app's active webhook subscription on Strava.
export async function DELETE() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const config = loadStravaConfig();
  if (!config) return NextResponse.json({ error: "Strava not configured" }, { status: 400 });

  try {
    // Look the id up rather than trusting the stored one — the subscription
    // may have been created before we started recording webhookSubscriptionId.
    const params = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret });
    const listRes = await fetch(`https://www.strava.com/api/v3/push_subscriptions?${params}`);
    const subs = await listRes.json() as { id: number }[];
    const active = subs?.[0];
    if (!active) return NextResponse.json({ ok: true, reason: "No active subscription" });

    const res = await fetch(`https://www.strava.com/api/v3/push_subscriptions/${active.id}?${params}`, { method: "DELETE" });
    if (!res.ok && res.status !== 204) {
      const data = await res.json().catch(() => ({}));
      return NextResponse.json({ error: `Strava rejected unsubscribe: ${JSON.stringify(data)}` }, { status: 502 });
    }
    updateStravaConfig({ webhookSubscriptionId: undefined });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unsubscribe failed" }, { status: 502 });
  }
}

// Check the current subscription status directly with Strava.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const config = loadStravaConfig();
  if (!config) return NextResponse.json({ subscribed: false });

  try {
    const params = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret });
    const res = await fetch(`https://www.strava.com/api/v3/push_subscriptions?${params}`);
    const data = await res.json() as { id: number; callback_url: string }[];
    const active = data?.[0];
    return NextResponse.json({ subscribed: !!active, subscriptionId: active?.id ?? null, callbackUrl: active?.callback_url ?? null });
  } catch {
    return NextResponse.json({ subscribed: false });
  }
}
