import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import QRCode from "qrcode";
import {
  generateTotpSecret, loadLocalAuth, otpauthUrl, saveLocalAuth, verifyTotp,
} from "@/lib/local-auth";

// 2FA enrolment for the logged-in user. GET provisions a (pending) secret and
// returns the QR; POST confirms a code and switches 2FA on; DELETE turns it
// off again (requires a valid current code).

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const config = loadLocalAuth();
  if (!config) return NextResponse.json({ error: "Local auth not configured" }, { status: 500 });

  if (!config.totpSecret) {
    config.totpSecret = generateTotpSecret();
    config.totpEnabled = false;
    saveLocalAuth(config);
  }

  const url = otpauthUrl(config);
  const qrDataUrl = await QRCode.toDataURL(url, { width: 220, margin: 1 });
  return NextResponse.json({
    enabled: config.totpEnabled ?? false,
    secret: config.totpSecret,
    qrDataUrl,
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { code } = await req.json() as { code?: string };
  const config = loadLocalAuth();
  if (!config?.totpSecret) return NextResponse.json({ error: "No pending 2FA setup" }, { status: 400 });
  if (!code || !verifyTotp(config.totpSecret, code)) {
    return NextResponse.json({ error: "Code didn't match — check the authenticator and try again" }, { status: 400 });
  }

  config.totpEnabled = true;
  saveLocalAuth(config);
  return NextResponse.json({ ok: true, enabled: true });
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { code } = await req.json() as { code?: string };
  const config = loadLocalAuth();
  if (!config?.totpEnabled || !config.totpSecret) {
    return NextResponse.json({ error: "2FA is not enabled" }, { status: 400 });
  }
  if (!code || !verifyTotp(config.totpSecret, code)) {
    return NextResponse.json({ error: "Code didn't match — a valid current code is needed to disable 2FA" }, { status: 400 });
  }

  config.totpEnabled = false;
  delete config.totpSecret; // fresh secret next time it's enabled
  saveLocalAuth(config);
  return NextResponse.json({ ok: true, enabled: false });
}
