import { parseBpmSpec } from "@/lib/bpm-spec";
import { formatArtistName } from "@/lib/artist-list";

// Sends artists to the Song Crawler from outside its own page (e.g. the Genre explorer's
// right-click > Lookup). Uses the crawl settings saved from the Song Crawler page - BPM,
// sources and limits, kept on the server - and the server starts a crawl straight away if
// none is running, otherwise queues the artist behind the one in progress.

export async function queueCrawlerLookup(credits: string[]): Promise<{ ok: boolean; message: string }> {
  const d = await fetch("/api/tracks/song-crawler/inputs").then(r => r.json()).catch(() => null) as
    { inputs: { bpm?: string; maxArtists?: string; reviewLimit?: string; sources?: { artist: boolean; radio: boolean; related: boolean } } | null } | null;
  const saved = d?.inputs ?? {};
  const bpm = saved.bpm ?? "";
  if (!bpm.trim() || !parseBpmSpec(bpm).ok) {
    return { ok: false, message: "Set a BPM on the Song Crawler page first - Lookup uses the crawl settings from there." };
  }
  const names: string[] = [];
  for (const credit of credits) {
    const name = credit.split(";")[0].trim();
    if (name && !names.some(n => n.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  // Show who was looked up in the Song Crawler page's Artist field: saved to the server, which
  // every open copy of that page follows.
  if (names.length > 0) {
    await fetch("/api/tracks/song-crawler/inputs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artist: names.map(formatArtistName).join(", ") }),
    }).catch(() => null);
  }
  const results: string[] = [];
  let ok = names.length > 0;
  for (const name of names) {
    const res = await fetch("/api/tracks/song-crawler", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enqueue: true,
        artist: formatArtistName(name),
        bpmSpec: bpm.trim(),
        maxArtists: parseInt(saved.maxArtists ?? "", 10) > 0 ? parseInt(saved.maxArtists!, 10) : 50,
        reviewLimit: parseInt(saved.reviewLimit ?? "", 10) > 0 ? parseInt(saved.reviewLimit!, 10) : null,
        sources: saved.sources ?? { artist: false, radio: true, related: false },
      }),
    }).catch(() => null);
    const d = res ? await res.json().catch(() => ({})) as { started?: boolean; queued?: number; error?: string } : { error: "Couldn't reach the server" };
    if (!res?.ok) { ok = false; results.push(`${name}: ${d.error ?? "failed"}`); continue; }
    results.push(d.started ? `crawling ${name} now` : `${name} queued (${d.queued} waiting)`);
  }
  return { ok, message: results.length ? `Lookup: ${results.join("; ")}` : "Lookup: no artist to look up" };
}
