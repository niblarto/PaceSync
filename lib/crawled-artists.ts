import { getDb } from "@/lib/db";

// The artists the Song Crawler has visited, newest first - the "Crawled artists" log on the crawler
// page and in the phone app. Kept on disk across crawls and restarts. An artist crawled again moves to
// the top and adds up its counts.
const KEY = "crawled_artists";
const MAX = 500;

export interface CrawledArtist {
  id: number;      // Deezer artist id
  name: string;
  at: string;      // when it was last crawled (ISO)
  added: number;   // songs added to the library from this artist, over all its crawls
  crawls: number;  // how many times it has been crawled
}

export function loadCrawledArtists(): CrawledArtist[] {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    if (row) {
      const list = JSON.parse(row.value_json) as CrawledArtist[];
      if (Array.isArray(list)) return list;
    }
  } catch { /* fall through */ }
  return [];
}

export function recordCrawledArtist(a: { id: number; name: string; added: number }): void {
  try {
    const list = loadCrawledArtists();
    const i = list.findIndex(x => x.id === a.id);
    const prev = i >= 0 ? list.splice(i, 1)[0] : null;
    list.unshift({
      id: a.id,
      name: a.name,
      at: new Date().toISOString(),
      added: (prev?.added ?? 0) + Math.max(0, a.added),
      crawls: (prev?.crawls ?? 0) + 1,
    });
    getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
      .run(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch { /* the log is a convenience - never let it break a crawl */ }
}

export function clearCrawledArtists(): void {
  try {
    getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
      .run(KEY, "[]");
  } catch { /* ignore */ }
}
