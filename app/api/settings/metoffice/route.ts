import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadMetOfficeConfig, saveMetOfficeConfig, DEFAULT_LOCATION } from "@/lib/metoffice-config";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const config = loadMetOfficeConfig();
  return NextResponse.json({
    hasKey: !!config,
    postcode: config?.postcode ?? DEFAULT_LOCATION.postcode,
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { apiKey?: string; postcode?: string };
  const existing = loadMetOfficeConfig();
  const apiKey = body.apiKey?.trim() || existing?.apiKey;
  if (!apiKey) return NextResponse.json({ error: "API key required" }, { status: 400 });

  let { postcode, lat, lon } = existing ?? { ...DEFAULT_LOCATION };
  const newPostcode = body.postcode?.trim().toUpperCase();
  if (newPostcode && newPostcode !== postcode) {
    const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(newPostcode)}`);
    if (!res.ok) return NextResponse.json({ error: "Postcode not found" }, { status: 400 });
    const d = await res.json() as { result: { latitude: number; longitude: number } };
    postcode = newPostcode;
    lat = d.result.latitude;
    lon = d.result.longitude;
  }

  saveMetOfficeConfig({ apiKey, postcode, lat, lon });
  return NextResponse.json({ ok: true });
}
