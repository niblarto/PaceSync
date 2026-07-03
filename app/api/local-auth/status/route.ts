import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, loadLocalAuth, verifyAuthToken } from "@/lib/local-auth";

export async function GET(req: NextRequest) {
  const config = loadLocalAuth();
  const token = req.cookies.get(AUTH_COOKIE)?.value;
  const authenticated = token ? await verifyAuthToken(token) : false;
  return NextResponse.json({
    authenticated,
    totpEnabled: config?.totpEnabled ?? false,
  });
}
