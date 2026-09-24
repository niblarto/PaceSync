import { getDb } from "@/lib/db";

// Tracks explicitly confirmed by the user as NOT a duplicate of whatever
// else they were grouped with in Settings' "Possible duplicates" review
// (e.g. two different remixes that share the stripped-down match key but
// are genuinely different songs — confirmed real case: "How Bout Now
// (Derriscott remix)" vs "(Dee Jay Prism remix)"). Detection there is
// deliberately broad/imprecise (same reasoning the user gave: flag
// candidates, let the person actually listen and decide) — this is the
// "I checked, they're different, stop asking" memory so a confirmed track
// doesn't keep reappearing in that list on every future visit.

export function isConfirmedUnique(uri: string): boolean {
  const row = getDb().prepare("SELECT 1 FROM confirmed_unique_tracks WHERE uri = ?").get(uri);
  return !!row;
}

export function loadConfirmedUniqueUris(): Set<string> {
  const rows = getDb().prepare("SELECT uri FROM confirmed_unique_tracks").all() as { uri: string }[];
  return new Set(rows.map(r => r.uri));
}

export function markConfirmedUnique(uri: string): void {
  getDb().prepare(
    "INSERT INTO confirmed_unique_tracks (uri, confirmed_at) VALUES (?, ?) ON CONFLICT(uri) DO UPDATE SET confirmed_at = excluded.confirmed_at"
  ).run(uri, new Date().toISOString());
}
