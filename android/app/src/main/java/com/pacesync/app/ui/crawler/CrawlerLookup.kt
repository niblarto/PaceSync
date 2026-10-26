package com.pacesync.app.ui.crawler

import com.pacesync.app.network.PaceSyncApi
import com.pacesync.app.network.dto.CrawlInputsRequest
import com.pacesync.app.network.dto.StartCrawlRequest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// "Lookup" from anywhere in the app (a track's long-press menu): sends that track's artist to the
// Song Crawler. It starts crawling straight away if no crawl is running, otherwise the artist joins
// the server's queue behind the crawl in progress. Uses the crawl settings saved on the server (the
// ones set on the Song Crawler screen / web page: BPM, sources, limits) and returns a message to show.
internal suspend fun lookupArtistInCrawler(api: PaceSyncApi, credit: String): String {
    val name = credit.substringBefore(';').trim()
    if (name.isEmpty()) return "No artist to look up"
    val inputs = runCatching { api.getCrawlInputs() }.getOrNull()?.takeIf { it.isSuccessful }?.body()?.inputs
    val bpm = inputs?.bpm?.trim().orEmpty()
    if (inputs == null || bpm.isEmpty() || !bpmSpecValid(bpm)) {
        return "Set a BPM on the Song Crawler screen first - Lookup uses the crawl settings from there."
    }
    val quoted = if (name.contains(',')) "\"$name\"" else name
    val resp = runCatching {
        api.startCrawl(
            StartCrawlRequest(
                artist = quoted,
                bpmSpec = bpm,
                maxArtists = inputs.maxArtists.toIntOrNull()?.takeIf { it > 0 } ?: 50,
                sources = inputs.sources,
                reviewLimit = inputs.reviewLimit.toIntOrNull()?.takeIf { it > 0 },
                enqueue = true,
            ),
        )
    }.getOrNull() ?: return "Couldn't reach PaceSync server"
    if (!resp.isSuccessful) {
        return resp.errorBody()?.string()?.let {
            runCatching { Json.parseToJsonElement(it).jsonObject["error"]?.jsonPrimitive?.content }.getOrNull()
        } ?: "Couldn't look up $name (${resp.code()})"
    }
    // Show who was looked up in the crawler's Artist field (shared with the web page).
    runCatching {
        api.saveCrawlInputs(CrawlInputsRequest(quoted, inputs.link, inputs.bpm, inputs.maxArtists, inputs.reviewLimit, inputs.sources))
    }
    val body = resp.body()
    return if (body?.started == true) "Crawling $name now" else "$name queued (${body?.queued ?: 0} waiting)"
}
