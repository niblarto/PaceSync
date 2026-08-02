import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { nudgeBpmOverride, clearBpmOverride } from "@/lib/bpm-track-overrides";
import { activeCsvPath, loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { regenerateCsvFile } from "@/lib/tracks-store";

// Nudges (or clears) a single track's persistent BPM override — see
// lib/bpm-track-overrides.ts for why this wins over the CSV/library value
// everywhere. Triggered by the "too fast" / "too slow" buttons on the run
// detail page (app/run/[date]).

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { uri, direction, baseline } = await req.json() as {
    uri?: string; direction?: "slower" | "faster"; baseline?: number;
  };
  if (!uri || (direction !== "slower" && direction !== "faster") || typeof baseline !== "number") {
    return NextResponse.json({ error: "uri, direction (slower|faster), and baseline required" }, { status: 400 });
  }

  const override = nudgeBpmOverride(uri, direction, baseline);
  // Keep the Python-facing materialized CSV in sync immediately — otherwise
  // the local AI DJ fallback subprocess wouldn't see this correction until
  // some unrelated write next regenerated the file.
  const config = loadRunningPlaylistConfig();
  regenerateCsvFile(config.csvFile, activeCsvPath()).catch(e => console.warn("[bpm-override] CSV regen failed:", e));
  return NextResponse.json({ ok: true, override });
}

// Resets a track back to its library BPM (undoes every prior nudge).
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { uri } = await req.json() as { uri?: string };
  if (!uri) return NextResponse.json({ error: "uri required" }, { status: 400 });

  clearBpmOverride(uri);
  const config = loadRunningPlaylistConfig();
  regenerateCsvFile(config.csvFile, activeCsvPath()).catch(e => console.warn("[bpm-override] CSV regen failed:", e));
  return NextResponse.json({ ok: true });
}
