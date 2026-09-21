import { getDb } from "@/lib/db";

// Discogs personal access token, configured in Settings > Integrations —
// used to search Discogs' release database by genre/style (real controlled-
// vocabulary tags, unlike Deezer's plain-text genre: search filter) to find
// artists to seed the "replace by BPM" online lookup with. See
// lib/discogs-artist-search.ts for how this is used.
const KEY = "discogs_config";

export interface DiscogsConfig {
  apiToken: string;
}

export function loadDiscogsConfig(): DiscogsConfig | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    if (!row) return null;
    const data = JSON.parse(row.value_json) as DiscogsConfig;
    if (data?.apiToken) return data;
  } catch {}
  return null;
}

export function saveDiscogsConfig(config: DiscogsConfig): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(config));
}
