import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import fs from "fs";
import os from "os";
import path from "path";

// GPS track for a Garmin Connect COURSE (not a GarminDB activity) — for the
// Races page's "link a course by URL/ID" flow. Courses live only on
// Garmin Connect's own servers (confirmed: GarminDB's local sync only ever
// writes Activities/Monitoring .fit files, no Courses folder at all), so
// this is a live API call every time, unlike /api/garmin/route/[id] which
// reads straight from the local GarminDB. Reuses the same DI-token auth
// /api/garmin/courses already established.
//
// Response shape matches /api/garmin/route/[id] exactly (name, distance,
// elapsedTime, points as [lat,lng,speedMph|null,elapsedSec|null,cumMi])
// so components/RouteMapLightbox.tsx can render either with the same
// component, given an alternate fetch source.

const TOKENS_FILE = path.join(os.homedir(), ".GarminDb", "garmin_tokens.json");
const METERS_PER_MILE = 1609.34;

interface DiTokens {
  di_token: string;
  di_refresh_token: string;
  di_client_id: string;
}

interface CourseGeoPoint {
  latitude: number;
  longitude: number;
  elevation: number | null;
  distance: number; // meters, cumulative
  timestamp: number;
}

interface CourseDetail {
  courseName: string;
  distanceMeter: number | null;
  elapsedSeconds: number | null;
  geoPoints: CourseGeoPoint[] | null;
}

function loadTokens(): DiTokens | null {
  try {
    const t = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf-8")) as DiTokens;
    if (t.di_token && t.di_refresh_token && t.di_client_id) return t;
  } catch { /* */ }
  return null;
}

// Same rotate-and-persist pattern as /api/garmin/courses's own refreshDiToken.
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

async function fetchCourseDetail(token: string, courseId: string): Promise<Response> {
  return fetch(`https://connectapi.garmin.com/course-service/course/${courseId}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
}

export async function GET(req: NextRequest, { params }: { params: { courseId: string } }) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const courseId = params.courseId.trim();
  if (!/^\d+$/.test(courseId)) return NextResponse.json({ error: "Invalid course id" }, { status: 400 });

  const tokens = loadTokens();
  if (!tokens) return NextResponse.json({ error: "Garmin tokens not found (is GarminDB set up?)" }, { status: 503 });

  try {
    let res = await fetchCourseDetail(tokens.di_token, courseId);
    if (res.status === 401 || res.status === 403) {
      const fresh = await refreshDiToken(tokens);
      if (!fresh) return NextResponse.json({ error: "Garmin token expired and refresh failed" }, { status: 502 });
      res = await fetchCourseDetail(fresh, courseId);
    }
    if (res.status === 404) return NextResponse.json({ error: "Course not found" }, { status: 404 });
    if (!res.ok) return NextResponse.json({ error: `Garmin course fetch failed (${res.status})` }, { status: 502 });

    const detail = await res.json() as CourseDetail;
    if (!detail.geoPoints?.length) return NextResponse.json({ error: "No GPS data for this course" }, { status: 404 });

    const points: [number, number, number | null, number | null, number][] = detail.geoPoints.map(p => [
      p.latitude, p.longitude, null, null, p.distance / METERS_PER_MILE,
    ]);

    return NextResponse.json({
      name: detail.courseName ?? null,
      distance: detail.distanceMeter != null ? detail.distanceMeter / METERS_PER_MILE : null,
      elapsedTime: detail.elapsedSeconds ?? null,
      points,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Course route fetch failed" }, { status: 502 });
  }
}
