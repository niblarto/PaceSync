import { getDb } from "@/lib/db";

// The Song Crawler form (artist, link, BPM, max artists, review limit, sources), kept on the
// server so every browser shows the latest settings. Last write wins; `updatedAt` lets a page
// tell whether what it holds is out of date.
const KEY = "song_crawler_inputs";

export interface CrawlerInputs {
  artist: string;
  link: string;
  bpm: string; // "170", "120-122" or "121,145,167" (lib/bpm-spec.ts)
  maxArtists: string;
  reviewLimit: string;
  sources: { artist: boolean; radio: boolean; related: boolean };
  updatedAt: string | null;
}

const DEFAULTS: CrawlerInputs = {
  artist: "", link: "", bpm: "", maxArtists: "50", reviewLimit: "",
  sources: { artist: false, radio: true, related: false }, updatedAt: null,
};

const str = (v: unknown, fallback: string) => (typeof v === "string" ? v.slice(0, 500) : fallback);

function sanitize(raw: unknown, base: CrawlerInputs): CrawlerInputs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const s = (r.sources && typeof r.sources === "object" ? r.sources : {}) as Record<string, unknown>;
  return {
    artist: str(r.artist, base.artist),
    link: str(r.link, base.link),
    bpm: str(r.bpm, base.bpm),
    maxArtists: str(r.maxArtists, base.maxArtists),
    reviewLimit: str(r.reviewLimit, base.reviewLimit),
    sources: {
      artist: typeof s.artist === "boolean" ? s.artist : base.sources.artist,
      radio: typeof s.radio === "boolean" ? s.radio : base.sources.radio,
      related: typeof s.related === "boolean" ? s.related : base.sources.related,
    },
    updatedAt: base.updatedAt,
  };
}

// null until the form has been saved at least once.
export function loadCrawlerInputs(): CrawlerInputs | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    if (row) {
      const parsed = JSON.parse(row.value_json) as Record<string, unknown>;
      return { ...sanitize(parsed, DEFAULTS), updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null };
    }
  } catch { /* fall through */ }
  return null;
}

// Merges the given fields into what is saved (so a partial save, e.g. just the artist from a
// Lookup, leaves the rest alone) and stamps the time.
export function saveCrawlerInputs(patch: unknown): CrawlerInputs {
  const base = loadCrawlerInputs() ?? DEFAULTS;
  const merged = { ...sanitize(patch, base), updatedAt: new Date().toISOString() };
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(merged));
  return merged;
}
