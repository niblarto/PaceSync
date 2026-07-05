import { NextRequest } from "next/server";
import { sendNtfy } from "@/lib/ntfy";

const notify = sendNtfy;

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("secret") !== process.env.CRON_SECRET) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sent: string[] = [];

  // 1. Start notification
  await notify(
    "Starting weekly BBC playlist update — loading 3 programmes…",
    { title: "BBC Playlist Update Starting", tags: "musical_note,clipboard" }
  );
  sent.push("start");

  await new Promise(r => setTimeout(r, 500));

  // 2. Playlist success
  await notify(
    "Found 18 tracks, 16 matched on Spotify and added to Running playlist.",
    { title: "✅ 6 Music Playlist", tags: "white_check_mark,musical_note" }
  );
  sent.push("playlist-success");

  await new Promise(r => setTimeout(r, 500));

  // 3. Playlist success with rate limit
  await notify(
    "Found 19 tracks, 2 matched on Spotify and added to Running playlist. (rate limited — 298s wait, 17 tracks skipped)",
    { title: "✅ 6 Music's Indie Forever", tags: "white_check_mark,musical_note" }
  );
  sent.push("playlist-rate-limited");

  await new Promise(r => setTimeout(r, 500));

  // 4. Playlist failure
  await notify(
    "Error: BBC page 404",
    { title: "❌ Lauren Laverne failed", tags: "x", priority: "high" }
  );
  sent.push("playlist-failure");

  await new Promise(r => setTimeout(r, 500));

  // 5. Dedup running
  await notify(
    "Running dedup on Running playlist…",
    { title: "Running Dedup", tags: "broom" }
  );
  sent.push("dedup-start");

  await new Promise(r => setTimeout(r, 500));

  // 6. Dedup success
  await notify(
    "Removed 18 duplicates — 284 tracks remain.",
    { title: "✅ Dedup Complete", tags: "white_check_mark,broom" }
  );
  sent.push("dedup-success");

  await new Promise(r => setTimeout(r, 500));

  // 7. Dedup failure
  await notify(
    "Error: Spotify PUT 403: Forbidden",
    { title: "❌ Dedup Failed", tags: "x", priority: "high" }
  );
  sent.push("dedup-failure");

  await new Promise(r => setTimeout(r, 500));

  // 8. Final summary — all OK
  await notify(
    "✅ 6 Music Playlist: 16/18 added | ✅ Indie Forever: 2/19 added | ✅ Lauren Laverne: 35/41 added | ✅ Dedup: removed 18",
    { title: "✅ Weekly Update Complete", tags: "white_check_mark" }
  );
  sent.push("summary-ok");

  await new Promise(r => setTimeout(r, 500));

  // 9. Final summary — with errors
  await notify(
    "Completed with 1 error. ✅ 6 Music Playlist: 16/18 | ❌ Indie Forever: BBC page 404 | ✅ Lauren Laverne: 35/41 | ✅ Dedup: removed 18",
    { title: "⚠️ Weekly Update Done With Errors", tags: "warning" }
  );
  sent.push("summary-errors");

  return Response.json({ ok: true, sent });
}
