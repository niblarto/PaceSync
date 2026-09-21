// Discogs release search — the "search online by genre" ♻ picker's genre
// path used to be library-only (lib/genre-artists.ts's artistsSharingGenre,
// which can only surface artists already tagged in THIS library's own CSV).
// Discogs' /database/search endpoint has real genre/style filtering backed
// by its own controlled vocabulary (confirmed live: genre=Electronic&
// style=Drum n Bass&type=release returns genuinely tagged releases, unlike
// Deezer's genre: search field which turned out to be a plain-text title
// match) — so this queries Discogs directly for artists credited on
// releases tagged with the given genre/style, entirely independent of what
// this library already contains. Results still get handed to the existing
// deezerArtistTopTracks() + resolveByIsrc() pipeline afterward for actual
// BPM/audio-feature data — Discogs has none of that itself.
//
// Requires a personal access token (Settings > Integrations > Discogs,
// free, https://www.discogs.com/settings/developers) — without one this
// silently returns no results rather than erroring, since "genre search"
// should degrade to "no online top-up" rather than break the whole picker.

import { loadDiscogsConfig } from "@/lib/discogs-config";
import { discogsStyleForGenre } from "@/lib/discogs-genre-map";

const USER_AGENT = "PaceSync/1.0 +https://github.com";

interface DiscogsSearchResult {
  title?: string; // "Artist Name - Release Title" for type=release
}

// A release's title field is "Artist Name - Release Title" (Discogs'
// convention) or occasionally just "Release Title" with no dash for
// various-artist releases — those are skipped rather than guessed at.
function artistFromTitle(title: string): string | null {
  const dashIdx = title.indexOf(" - ");
  if (dashIdx === -1) return null;
  const artist = title.slice(0, dashIdx).trim();
  // Discogs disambiguates same-named artists with a trailing " (2)" etc.
  return artist.replace(/\s*\(\d+\)$/, "").trim() || null;
}

// Picks up to `count` items from `items` without replacement, using each
// item's `count` field as a relative weight (higher release count = more
// likely to be picked, but never guaranteed) — standard weighted reservoir
// approach: draw each item's key as Math.random() ** (1 / weight), then
// take the top `count` keys. Every item still has a nonzero chance
// regardless of weight, so repeated searches for the same genre surface
// different artists over time instead of a fixed top-N.
function weightedSampleWithoutReplacement<T extends { count: number }>(items: T[], count: number): T[] {
  return items
    .map(item => ({ item, key: Math.random() ** (1 / Math.max(item.count, 0.01)) }))
    .sort((a, b) => b.key - a.key)
    .slice(0, count)
    .map(x => x.item);
}

async function searchReleases(queryParam: string, apiToken: string): Promise<DiscogsSearchResult[]> {
  const url = `https://api.discogs.com/database/search?${queryParam}&type=release&per_page=100`;
  console.log(`[discogs] GET ${url}`);
  const res = await fetch(url, {
    headers: {
      "Authorization": `Discogs token=${apiToken}`,
      "User-Agent": USER_AGENT,
    },
  });
  console.log(`[discogs] response status ${res.status}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.log(`[discogs] non-OK response body: ${body.slice(0, 500)}`);
    return [];
  }
  const data = await res.json() as { results?: DiscogsSearchResult[]; pagination?: { items?: number } };
  const results = data.results ?? [];
  console.log(`[discogs] pagination.items=${data.pagination?.items ?? "?"} results.length=${results.length}`);
  return results;
}

/**
 * Artists credited on Discogs releases tagged with the given genre/style,
 * ranked by how many matching releases they're credited on, deduped, capped
 * at maxArtists. Returns [] (never throws) if no token is configured or the
 * request fails — callers treat this as "no online top-up available",  not
 * a hard error.
 */
export async function discogsArtistsForGenre(genreOrStyle: string, maxArtists: number): Promise<string[]> {
  const config = loadDiscogsConfig();
  if (!config?.apiToken) {
    console.log("[discogs] no token configured — skipping Discogs, falling back to library genre search");
    return [];
  }
  const query = genreOrStyle.trim();
  if (!query) {
    console.log("[discogs] empty genre/style query — skipping");
    return [];
  }

  try {
    // style= is an exact match against Discogs' own fixed vocabulary (e.g.
    // "Drum n Bass" — confirmed live) and returns NOTHING for anything that
    // isn't one of their exact tags, including reasonable-sounding
    // subgenre names like "Liquid Funk" that Discogs simply doesn't have as
    // a distinct style. lib/discogs-genre-map.ts translates this library's
    // own genre tags to their verified-real Discogs style equivalent first;
    // if there's no mapping (or the query wasn't one of this library's
    // known tags at all), try the raw value as a style= match, then fall
    // back to a general text search (q=), which is fuzzier (matches
    // titles/credits, not just genre metadata) but still finds real
    // releases for a query that isn't literally a Discogs style tag.
    const mappedStyle = discogsStyleForGenre(query);
    if (mappedStyle) console.log(`[discogs] mapped library genre "${query}" -> Discogs style "${mappedStyle}"`);
    let results = await searchReleases(`style=${encodeURIComponent(mappedStyle ?? query)}`, config.apiToken);
    if (results.length === 0 && mappedStyle && mappedStyle.toLowerCase() !== query.toLowerCase()) {
      console.log(`[discogs] mapped style "${mappedStyle}" found nothing — trying raw query as style= too`);
      results = await searchReleases(`style=${encodeURIComponent(query)}`, config.apiToken);
    }
    if (results.length === 0) {
      console.log(`[discogs] style= exact match found nothing for "${query}" — falling back to general query search`);
      results = await searchReleases(`q=${encodeURIComponent(query)}`, config.apiToken);
    }

    const counts = new Map<string, { name: string; count: number }>();
    let skippedNoDash = 0;
    for (const r of results) {
      if (!r.title) continue;
      const artist = artistFromTitle(r.title);
      if (!artist) { skippedNoDash++; continue; }
      const key = artist.toLowerCase();
      const existing = counts.get(key);
      if (existing) existing.count++;
      else counts.set(key, { name: artist, count: 1 });
    }
    console.log(`[discogs] parsed ${counts.size} distinct artists from titles (skipped ${skippedNoDash} titles with no " - " artist separator)`);

    // A strict top-N-by-release-count pick is deterministic — the same
    // handful of most-prolific-on-Discogs artists for a genre win on every
    // single search, since a 100-release page from Discogs' own relevance
    // ranking barely varies request to request. Weighted-random sampling
    // (still favoring higher release counts, just not guaranteeing them)
    // gives real variety across repeated searches instead of always
    // checking the same artists.
    const picked = weightedSampleWithoutReplacement(Array.from(counts.values()), maxArtists);
    const ranked = picked.map(a => a.name);
    console.log(`[discogs] picked ${ranked.length} artists (weighted random) for "${query}": ${JSON.stringify(ranked)}`);
    return ranked;
  } catch (err) {
    console.log(`[discogs] request threw: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
