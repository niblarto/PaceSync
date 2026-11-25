import { garminConnectGet, garminConnectSend } from "@/lib/garmin-connect";

// Sends a route to Garmin Connect as a private running course, so it syncs to the watch. Garmin's web "Import"
// page parses a GPX file (course-service/course/import) and then saves what it parsed (course-service/course);
// this does the same two steps. A course only reaches the watch once it is also "sent to device" (a device message
// that the watch collects at its next sync), which is a third step: sendCourseToDevices().

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

async function createCourse(name: string, points: LatLng[]): Promise<{ courseId: number }> {
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


// Garmin Connect's "Send to Device": queues the course for each of your course-capable watches (the Forerunner 965…).
// The watch collects it the next time it syncs with Garmin Connect.
export async function sendCourseToDevices(courseId: number, name: string): Promise<{ devices: string[]; error?: string }> {
  try {
    const all = await garminConnectGet<{ deviceId?: number; productDisplayName?: string; courseCapable?: boolean }[]>("/device-service/deviceregistration/devices");
    const watches = all.filter(d => d.courseCapable && typeof d.deviceId === "number");
    if (watches.length === 0) return { devices: [], error: "No course-capable device found in your Garmin account." };
    const sent: string[] = [];
    for (const w of watches) {
      // The endpoint takes a list of flat messages (the queue reads them back with the details under metaData, but
      // posting that shape is rejected).
      const body = [{
        deviceId: w.deviceId, messageType: "courses", fileType: "FIT", metaDataId: courseId, messageName: name, groupName: null, priority: 0,
        messageUrl: `course-service/course/fit/${courseId}/${w.deviceId}?elevation=true`,
      }];
      const r = await garminConnectSend("POST", "/devicemessage-service/devicemessage/messages", JSON.stringify(body), "application/json");
      if (!r.ok) return { devices: sent, error: `Garmin wouldn't queue it for ${w.productDisplayName ?? "your watch"} (${r.status}): ${detail(r.data)}` };
      sent.push(w.productDisplayName ?? "your watch");
    }
    return { devices: sent };
  } catch (e) {
    return { devices: [], error: e instanceof Error ? e.message : "Couldn't send to the device" };
  }
}

// Creates the course in Garmin Connect, then sends it to your watch(es).
export async function sendCourseToGarmin(name: string, points: LatLng[]): Promise<{ courseId: number; devices: string[]; deviceError?: string }> {
  const { courseId } = await createCourse(name, points);
  const dev = await sendCourseToDevices(courseId, name);
  return { courseId, devices: dev.devices, ...(dev.error ? { deviceError: dev.error } : {}) };
}
