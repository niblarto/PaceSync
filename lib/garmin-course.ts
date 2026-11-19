import { garminConnectSend } from "@/lib/garmin-connect";

// Sends a route to Garmin Connect as a private running course, so it syncs to the watch. Garmin's web "Import"
// page parses a GPX file (course-service/course/import) and then saves what it parsed (course-service/course);
// this does the same two steps.

type LatLng = [number, number];

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c] as string));
}

function toGpx(name: string, points: LatLng[]): string {
  const pts = points.map(p => `<trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="PaceSync" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${escapeXml(name)}</name><trkseg>${pts}</trkseg></trk></gpx>`;
}

function detail(data: unknown): string {
  const t = typeof data === "string" ? data : JSON.stringify(data);
  return t.slice(0, 300);
}

export async function sendCourseToGarmin(name: string, points: LatLng[]): Promise<{ courseId: number }> {
  const form = new FormData();
  form.append("file", new Blob([toGpx(name, points)], { type: "application/gpx+xml" }), `${name.replace(/[^\w.-]+/g, "-")}.gpx`);
  const imp = await garminConnectSend("POST", "/course-service/course/import", form);
  if (!imp.ok) throw new Error(`Garmin rejected the GPX import (${imp.status}): ${detail(imp.data)}`);

  const parsed = imp.data as Record<string, unknown> | null;
  if (parsed && typeof parsed === "object") {
    // Some responses already carry the saved course's id.
    if (typeof parsed.courseId === "number") return { courseId: parsed.courseId };
    if (Array.isArray(parsed.geoPoints)) {
      // rulePK is the privacy setting (1 public, 2 private, 4 group); activityTypePk 1 is running.
      const geo = parsed.geoPoints as { latitude: number; longitude: number; distance?: number | null }[];
      const lats = geo.map(g => g.latitude), lons = geo.map(g => g.longitude);
      const lastDist = geo[geo.length - 1]?.distance;
      const body = {
        ...parsed, courseName: name, rulePK: 2, activityTypePk: 1,
        sourceTypeId: 3, // imported from a file
        coordinateSystem: "WGS84", originalCoordinateSystem: "WGS84", targetCoordinateSystem: "WGS84",
        startPoint: { latitude: geo[0].latitude, longitude: geo[0].longitude, elevation: null, distance: 0, timestamp: null },
        boundingBox: {
          lowerLeft: { latitude: Math.min(...lats), longitude: Math.min(...lons) },
          upperRight: { latitude: Math.max(...lats), longitude: Math.max(...lons) },
        },
        distanceMeter: typeof lastDist === "number" ? lastDist : null,
        elevationGainMeter: 0, elevationLossMeter: 0,
      };
      const saved = await garminConnectSend("POST", "/course-service/course", JSON.stringify(body), "application/json");
      if (!saved.ok) throw new Error(`Garmin couldn't save the course (${saved.status}): ${detail(saved.data)}`);
      const id = (saved.data as { courseId?: number } | null)?.courseId;
      if (typeof id === "number") return { courseId: id };
      throw new Error(`Garmin saved the course but returned no id: ${detail(saved.data)}`);
    }
  }
  throw new Error(`Unexpected reply from Garmin's course import: ${detail(imp.data)}`);
}
