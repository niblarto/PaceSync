import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { clearLookupCredentials, lookupAccountConnected, lookupAccountDisconnect, lookupAppConfigured, lookupCredentials, lookupRedirectUri, saveLookupCredentials } from "@/lib/spotify-lookup-account";

// The secondary lookup account's state for the Settings card.
//   GET    -> { configured, connected, redirectUri, clientIdHint, credentialsSource }   (never the secret)
//   POST   { clientId, clientSecret } -> save the lookup app's credentials (Settings); { clear: true } forgets them
//   DELETE -> sign the account out (forget its tokens)
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const c = lookupCredentials();
  return NextResponse.json({
    configured: lookupAppConfigured(), connected: lookupAccountConnected(), redirectUri: lookupRedirectUri(),
    clientIdHint: c ? `${c.id.slice(0, 4)}…${c.id.slice(-4)}` : null, credentialsSource: c?.source ?? null,
  });
}

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { clientId?: string; clientSecret?: string; clear?: boolean };
  if (body.clear) { clearLookupCredentials(); return NextResponse.json({ ok: true }); }
  const id = body.clientId?.trim() ?? "";
  const secret = body.clientSecret?.trim() ?? "";
  if (!/^[A-Za-z0-9]{32}$/.test(id) || !/^[A-Za-z0-9]{32}$/.test(secret)) {
    return NextResponse.json({ error: "A Spotify client id and secret are each 32 letters/numbers" }, { status: 400 });
  }
  saveLookupCredentials(id, secret);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  lookupAccountDisconnect();
  return NextResponse.json({ ok: true });
}
