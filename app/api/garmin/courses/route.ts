import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import fs from "fs";
import os from "os";
import path from "path";

// Lists the user's Garmin Connect courses (created routes), for suggesting a
// course on the Runna schedule cards. Reuses the auth tokens GarminDB keeps
// for its nightly sync — no separate Garmin login needed.

const TOKENS_FILE = path.join(os.homedir(), ".GarminDb", "garmin_tokens.json");

interface DiTokens {
  di_token: string;
  di_refresh_token: string;
  di_client_id: string;
}

export interface GarminCourse {
  id: number;
  name: string;
  distanceMi: number;
  createdDate: number; // epoch ms
}

interface RawCourse {
  courseId: number;
  courseName: string;
  distanceInMeters: number | null;
  createdDate: number;
  activityType?: { typeKey?: string };
}

// Courses change rarely — don't hit Garmin on every card expand.
let cache: { at: number; courses: GarminCourse[] } | null = null;
const CACHE_TTL_MS = 5 * 60_000;

function loadTokens(): DiTokens | null {
  try {
    const t = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf-8")) as DiTokens;
    if (t.di_token && t.di_refresh_token && t.di_client_id) return t;
  } catch {}
  return null;
}

// GarminDB's daily sync normally keeps the token fresh (~21h lifetime); this
// covers the gap if it lapses. The rotated token pair is written back to the
// same file so GarminDB's next sync picks it up rather than breaking.
async function refreshDiToken(t: DiTokens): Promise<string | null> {
  const res = await fetch("https://diauth.garmin.com/di-oauth2-service/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: t.di_refresh_token,
      client_id: t.di_client_id,
    }),
  });
  if (!res.ok) return null;
  const d = await res.json() as { access_token: string; refresh_token?: string };
  fs.writeFileSync(TOKENS_FILE, JSON.stringify({
    di_token: d.access_token,
    di_refresh_token: d.refresh_token ?? t.di_refresh_token,
    di_client_id: t.di_client_id,
  }), "utf-8");
  return d.access_token;
}

async function fetchCourseList(token: string): Promise<Response> {
  return fetch("https://connectapi.garmin.com/course-service/course", {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return NextResponse.json({ courses: cache.courses });
  }

  const tokens = loadTokens();
  if (!tokens) return NextResponse.json({ error: "Garmin tokens not found (is GarminDB set up?)" }, { status: 503 });

  try {
    let res = await fetchCourseList(tokens.di_token);
    if (res.status === 401 || res.status === 403) {
      const fresh = await refreshDiToken(tokens);
      if (!fresh) return NextResponse.json({ error: "Garmin token expired and refresh failed" }, { status: 502 });
      res = await fetchCourseList(fresh);
    }
    if (!res.ok) return NextResponse.json({ error: `Garmin course list failed (${res.status})` }, { status: 502 });

    const raw = await res.json() as RawCourse[];
    const courses: GarminCourse[] = raw
      .filter(c => c.activityType?.typeKey === "running" && (c.distanceInMeters ?? 0) > 0)
      .map(c => ({
        id: c.courseId,
        name: c.courseName,
        distanceMi: (c.distanceInMeters ?? 0) / 1609.34,
        createdDate: c.createdDate,
      }))
      .sort((a, b) => b.createdDate - a.createdDate);

    cache = { at: Date.now(), courses };
    return NextResponse.json({ courses });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Course fetch failed" }, { status: 502 });
  }
}
