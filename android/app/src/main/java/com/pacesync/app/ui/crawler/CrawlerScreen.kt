package com.pacesync.app.ui.crawler

import android.content.Context
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pacesync.app.R
import com.pacesync.app.network.PaceSyncApi
import com.pacesync.app.network.dto.CrawlAddedTrack
import com.pacesync.app.network.dto.CrawlJobDto
import com.pacesync.app.network.dto.CrawlLine
import com.pacesync.app.network.dto.CrawlRemoveRequest
import com.pacesync.app.network.dto.CrawlSources
import com.pacesync.app.network.dto.StartCrawlRequest
import com.pacesync.app.ui.common.PlaybackBar
import com.pacesync.app.ui.common.ScrollingBackground
import com.pacesync.app.ui.detail.playOnActiveDevice
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// Song Crawler tab — the same server-side job as web Settings > Tracklist
// (lib/song-crawler.ts). The crawl runs on the Pi regardless of the phone;
// this screen starts/stops it and polls its numbered log. Inputs are
// remembered on the phone.

private const val PREFS = "song_crawler"
private const val LOG_SHOWN = 400 // only the newest lines are drawn

private val TEAL = Color(0xFF2DD4BF)
private val AMBER = Color(0xFFFBBF24)
private val RED = Color(0xFFF87171)

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun CrawlerScreen(api: PaceSyncApi) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val prefs = remember { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }

    var artist by remember { mutableStateOf(prefs.getString("artist", "") ?: "") }
    var link by remember { mutableStateOf(prefs.getString("link", "") ?: "") }
    // "170", a range "120-122", or exact matches "121,145,167". Older saves kept
    // a range's top in a separate "bpmMax" pref.
    var bpm by remember {
        val b = prefs.getString("bpm", "") ?: ""
        val m = prefs.getString("bpmMax", "") ?: ""
        mutableStateOf(if (b.isNotBlank() && (m.toDoubleOrNull() ?: 0.0) > (b.toDoubleOrNull() ?: 0.0)) "$b-$m" else b)
    }
    var maxArtists by remember { mutableStateOf(prefs.getString("maxArtists", "50") ?: "50") }
    var reviewLimit by remember { mutableStateOf(prefs.getString("reviewLimit", "") ?: "") }
    var srcArtist by remember { mutableStateOf(prefs.getBoolean("srcArtist", false)) }
    var srcRadio by remember { mutableStateOf(prefs.getBoolean("srcRadio", true)) }
    var srcRelated by remember { mutableStateOf(prefs.getBoolean("srcRelated", false)) }

    fun saveInputs() {
        prefs.edit()
            .putString("artist", artist).putString("link", link)
            .putString("bpm", bpm).remove("bpmMax").putString("maxArtists", maxArtists).putString("reviewLimit", reviewLimit)
            .putBoolean("srcArtist", srcArtist).putBoolean("srcRadio", srcRadio).putBoolean("srcRelated", srcRelated)
            .apply()
    }

    var job by remember { mutableStateOf<CrawlJobDto?>(null) }
    val lines = remember { mutableStateListOf<CrawlLine>() }
    var since by remember { mutableStateOf(0) }
    var message by remember { mutableStateOf<String?>(null) }
    var menuFor by remember { mutableStateOf<String?>(null) }
    var playingUri by remember { mutableStateOf<String?>(null) }
    var pollNonce by remember { mutableStateOf(0) }
    var playNonce by remember { mutableStateOf(0) } // re-reads the playback bar after a tap

    val running = job?.status in setOf("running", "paused", "stopping", "healing")

    suspend fun poll() {
        val resp = runCatching { api.getCrawl(since) }.getOrNull() ?: return
        if (!resp.isSuccessful) return
        val body = resp.body() ?: return
        val j = body.job ?: run { job = null; return }
        if (job?.id != null && job?.id != j.id && since > 0) {
            // A different crawl started (e.g. from the web) — reload its log.
            lines.clear(); since = 0; job = j; pollNonce++; return
        }
        job = j
        if (body.lines.isNotEmpty()) {
            lines.addAll(body.lines)
            if (lines.size > 5000) lines.removeRange(0, lines.size - 5000)
            since = body.lines.last().seq + 1
        }
    }

    LaunchedEffect(pollNonce) {
        while (true) {
            poll()
            delay(if (running) 2000 else 10000)
        }
    }

    fun start() {
        if ((artist.isBlank() && link.isBlank()) || !bpmSpecValid(bpm)) {
            message = "Enter an artist or an album/playlist link, and a BPM (170, 120-122 or 121,145,167)"
            return
        }
        if (!srcArtist && !srcRadio && !srcRelated && link.isBlank()) {
            message = "Tick at least one of Artist / Radio / Related"
            return
        }
        saveInputs()
        message = null
        scope.launch {
            val req = StartCrawlRequest(
                artist = artist.trim(),
                link = link.trim().ifBlank { null },
                bpmSpec = bpm.trim(),
                maxArtists = maxArtists.toIntOrNull()?.takeIf { it > 0 } ?: 50,
                sources = CrawlSources(srcArtist, srcRadio, srcRelated),
                reviewLimit = reviewLimit.toIntOrNull()?.takeIf { it > 0 },
            )
            val resp = runCatching { api.startCrawl(req) }.getOrNull()
            if (resp == null) { message = "Couldn't reach PaceSync server"; return@launch }
            if (!resp.isSuccessful) {
                val err = resp.errorBody()?.string()?.let {
                    runCatching { Json.parseToJsonElement(it).jsonObject["error"]?.jsonPrimitive?.content }.getOrNull()
                }
                message = err ?: "Couldn't start the crawl (${resp.code()})"
                return@launch
            }
            lines.clear(); since = 0; job = null
            pollNonce++
        }
    }

    fun stop() {
        scope.launch { runCatching { api.stopCrawl() }; pollNonce++ }
    }

    // reason: "accepted" (keep), "deleted" (out + on the deleted list) or
    // "removed" (out of the library/playlist, but can be re-added later).
    fun removeAdded(t: CrawlAddedTrack, reason: String) {
        menuFor = null
        job = job?.copy(addedTracks = job!!.addedTracks.filter { it.uri != t.uri })
        scope.launch {
            runCatching {
                api.crawlRemoveAdded(CrawlRemoveRequest(t.uri, reason, deleteFromLibrary = reason != "accepted"))
            }
            pollNonce++
        }
    }

    fun play(uri: String) {
        menuFor = null
        playingUri = uri
        scope.launch { playOnActiveDevice(context, api, uri); playNonce++ }
    }

    val scroll = rememberScrollState()
    ScrollingBackground(scroll, imageRes = R.drawable.apk_background_settings) {
        Column(
            Modifier.fillMaxSize().verticalScroll(scroll).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            val cardColors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.9f))

            // ── Inputs ──
            Card(colors = cardColors, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = artist, onValueChange = { artist = it }, enabled = !running,
                        label = { Text("Artist") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = link, onValueChange = { link = it }, enabled = !running,
                        label = { Text("Artist / Album / Playlist (Spotify link)") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                        isError = link.isNotBlank() && !Regex("open\\.spotify\\.com/(?:intl-[a-z]+/)?(album|playlist|artist)/|spotify:(album|playlist|artist):").containsMatchIn(link),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(
                            value = bpm, onValueChange = { bpm = it }, enabled = !running,
                            label = { Text("BPM") }, singleLine = true, modifier = Modifier.weight(2f),
                            placeholder = { Text("170 · 120-122 · 121,145,167") },
                            isError = bpm.isNotBlank() && !bpmSpecValid(bpm),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
                        )
                        OutlinedTextField(
                            value = maxArtists, onValueChange = { maxArtists = it },
                            enabled = !running && (srcRadio || srcRelated),
                            label = { Text("Artists") }, singleLine = true, modifier = Modifier.weight(1f),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        )
                    }
                    OutlinedTextField(
                        value = reviewLimit,
                        onValueChange = { v ->
                            reviewLimit = v
                            prefs.edit().putString("reviewLimit", v).apply()
                            // While a crawl runs, a change applies to it straight away.
                            if (running) scope.launch {
                                runCatching { api.setCrawlReviewLimit(com.pacesync.app.network.dto.CrawlReviewLimitRequest(v.toIntOrNull()?.takeIf { it > 0 })) }
                            }
                        },
                        label = { Text("Review limit (pause at this many awaiting review)") },
                        placeholder = { Text("none") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Crawl:", style = MaterialTheme.typography.bodySmall)
                        Checkbox(checked = srcArtist, onCheckedChange = { srcArtist = it }, enabled = !running)
                        Text("Artist", style = MaterialTheme.typography.bodySmall)
                        Checkbox(checked = srcRadio, onCheckedChange = { srcRadio = it }, enabled = !running)
                        Text("Radio", style = MaterialTheme.typography.bodySmall)
                        Checkbox(checked = srcRelated, onCheckedChange = { srcRelated = it }, enabled = !running)
                        Text("Related", style = MaterialTheme.typography.bodySmall)
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Button(
                            onClick = { start() }, enabled = !running,
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF0D9488), contentColor = Color.White),
                        ) { Text("Crawl") }
                        if (running) {
                            OutlinedButton(onClick = { stop() }, enabled = job?.status == "running" || job?.status == "paused") {
                                Text(if (job?.status == "running" || job?.status == "paused") "Stop" else "Stopping…")
                            }
                        }
                    }
                    message?.let { Text(it, color = AMBER, style = MaterialTheme.typography.bodySmall) }
                }
            }

            // ── Status ──
            job?.let { j ->
                val label = when (j.status) {
                    "running" -> "Running"; "paused" -> "Paused (review limit)"; "stopping" -> "Stopping"; "healing" -> "Filling in data"
                    "stopped" -> "Last crawl (stopped)"; "error" -> "Last crawl (error)"
                    "interrupted" -> "Last crawl (interrupted)"; else -> "Last crawl"
                }
                val what = listOfNotNull(j.params.artist.ifBlank { null }, j.linkName).joinToString(" + ")
                val bpmText = j.params.bpmSpec?.takeIf { it.isNotBlank() }
                    ?: if (j.params.bpmMin != null && j.params.bpmMax != null)
                        "${j.params.bpmMin.toInt()}–${j.params.bpmMax.toInt()}" else "${j.params.bpm?.toInt() ?: ""}"
                val parts = listOfNotNull(
                    "$label: $what",
                    "$bpmText BPM",
                    j.checked?.let { "$it checked" },
                    "${j.added} added",
                    if (j.totalArtists > 0) "Artist ${j.crawled} of ${j.totalArtists}" else null,
                )
                // On its own card — straight over the background image it
                // was unreadable.
                Card(colors = cardColors, modifier = Modifier.fillMaxWidth()) {
                    Text(
                        parts.joinToString(" · "),
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.Medium,
                        color = if (running) TEAL else MaterialTheme.colorScheme.onSurface,
                    )
                }
            }

            // ── Log ──
            Card(colors = cardColors, modifier = Modifier.fillMaxWidth()) {
                val logScroll = rememberScrollState()
                LaunchedEffect(lines.size) { logScroll.animateScrollTo(logScroll.maxValue) }
                Box(Modifier.fillMaxWidth().height(320.dp).padding(10.dp)) {
                    Column(Modifier.verticalScroll(logScroll)) {
                        if (lines.isEmpty()) {
                            Text("No crawl yet — enter an artist or link and a BPM, then Crawl.", style = MaterialTheme.typography.bodySmall)
                        }
                        lines.takeLast(LOG_SHOWN).forEach { line ->
                            val time = line.at.substringAfter('T').take(8)
                            Text(
                                "$time ${line.msg}",
                                fontFamily = FontFamily.Monospace,
                                fontSize = 10.sp,
                                lineHeight = 13.sp,
                                fontWeight = if (line.level == "match") FontWeight.SemiBold else FontWeight.Normal,
                                color = when (line.level) {
                                    "match" -> TEAL; "warn" -> AMBER; "error" -> RED
                                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                                },
                            )
                        }
                    }
                }
            }

            // ── Awaiting review (crawled songs kept until accepted/deleted) ──
            val added = job?.addedTracks ?: emptyList()
            Card(colors = cardColors, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(10.dp)) {
                    Text("Awaiting review (${added.size})", style = MaterialTheme.typography.titleSmall)
                    Text("Tap to play · long-press to accept, delete or remove", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    PlaybackBar(api, refreshKey = playNonce, modifier = Modifier.padding(top = 6.dp))
                    Spacer(Modifier.height(6.dp))
                    if (added.isEmpty()) {
                        Text("Songs crawls add stay here until you accept or delete them.", style = MaterialTheme.typography.bodySmall)
                    }
                    added.forEach { t ->
                        Box {
                            Column(
                                Modifier.fillMaxWidth()
                                    .combinedClickable(onClick = { play(t.uri) }, onLongClick = { menuFor = t.uri })
                                    .padding(vertical = 6.dp),
                            ) {
                                Text(
                                    t.name, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                    color = if (playingUri == t.uri) TEAL else MaterialTheme.colorScheme.onSurface,
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                                Text("${t.artist} · ${t.bpm} BPM" + (if (t.bpm in 1..94) " (×2 = ${t.bpm * 2})" else ""), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            DropdownMenu(expanded = menuFor == t.uri, onDismissRequest = { menuFor = null }) {
                                DropdownMenuItem(text = { Text("▶ Play") }, onClick = { play(t.uri) })
                                DropdownMenuItem(text = { Text("✓ Accept", color = TEAL) }, onClick = { removeAdded(t, "accepted") })
                                DropdownMenuItem(text = { Text("🗑 Delete", color = RED) }, onClick = { removeAdded(t, "deleted") })
                                DropdownMenuItem(text = { Text("↩ Remove (can re-add)", color = AMBER) }, onClick = { removeAdded(t, "removed") })
                            }
                        }
                        HorizontalDivider()
                    }
                }
            }
            Spacer(Modifier.width(1.dp).height(8.dp))
        }
    }
}

// Mirrors lib/bpm-spec.ts: comma-separated BPMs and/or low-high ranges.
private val BPM_SPEC_PART = Regex("""\d+(?:\.\d+)?(?:\s*[-–—]\s*\d+(?:\.\d+)?)?""")

private fun bpmSpecValid(spec: String): Boolean {
    val parts = spec.split(',', ';').map { it.trim() }.filter { it.isNotEmpty() }
    if (parts.isEmpty()) return false
    return parts.all { part ->
        if (!BPM_SPEC_PART.matches(part)) return@all false
        val nums = part.split(Regex("[-–—]")).mapNotNull { it.trim().toDoubleOrNull() }
        nums.isNotEmpty() && nums.all { it > 0 } && (nums.size < 2 || nums[1] >= nums[0])
    }
}
