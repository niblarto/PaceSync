package com.pacesync.app.ui.detail

import android.app.Activity
import android.content.Intent
import android.content.pm.ActivityInfo
import android.net.Uri
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.toSize
import com.pacesync.app.network.PaceSyncApi
import com.pacesync.app.network.dto.HistoryTrack
import com.pacesync.app.network.dto.PlaybackActionRequest
import com.pacesync.app.network.dto.PlayRequest
import com.pacesync.app.ui.crawler.lookupArtistInCrawler
import com.pacesync.app.network.dto.RemixDoneEvent
import com.pacesync.app.network.dto.RemixRequest
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.math.roundToInt

// Target-pace-vs-song-BPM chart for a mix's tracklist — a port of the web
// app's MixPaceChart.tsx (chart + segment strip + track strip, all sharing
// one zoomable/pannable time axis), minus drag-to-reorder and the
// right-click context menu. Forced to landscape since the data reads far
// better wide than tall on a phone.
//
// The chart, segment strip, and track strip are NOT three independently
// laid-out pieces — they all read the same `visibleStart..visibleEnd`
// window (seconds) and compute their own x-positions against total time,
// so pinch-zoom/pan on the chart moves all three together. Confirmed bug
// in the prior static version: a separate LazyRow for tracks scrolled on
// its own, out of sync with the stationary chart, and track widths were
// all equal instead of duration-proportional — both fixed by sharing one
// transform instead of giving the track strip its own scroll state.
private const val DOUBLETIME_THRESHOLD = 95.0
private fun effectiveTempo(tempo: Double): Double = if (tempo < DOUBLETIME_THRESHOLD) tempo * 2 else tempo
private fun chartBpm(tempo: Double): Int = effectiveTempo(tempo).roundToInt()

// Cumulative mix time: m:ss, or h:mm:ss from an hour in.
private fun fmtElapsed(secs: Double): String {
    val total = secs.roundToInt()
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "$h:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}"
    else "$m:${s.toString().padStart(2, '0')}"
}

private fun fmtMs(ms: Long): String {
    val totalSec = ms / 1000
    val m = totalSec / 60
    val s = totalSec % 60
    return "$m:${s.toString().padStart(2, '0')}"
}

private fun fmtPace(secs: Double): String {
    val m = (secs / 60).toInt()
    val s = (secs % 60).roundToInt()
    return "$m:${s.toString().padStart(2, '0')}"
}

private val SEGMENT_COLORS = listOf(
    Color(0xFF34D399), Color(0xFF60A5FA), Color(0xFFF59E0B),
    Color(0xFFF472B6), Color(0xFFA78BFA), Color(0xFF38BDF8),
)

// Rebuilds a pin-shaped timeline (grouped by segment) from a flat,
// post-splice HistoryTrack list — the inverse of flattening a timeline into
// HistoryTrack rows, same approach the server's own
// historyTracksToTimeline (app/api/ai-dj/pin/route.ts) uses, kept here
// since the Android client needs to build the POST body itself.
internal fun buildTimelineFromTracks(tracks: List<HistoryTrack>): List<com.pacesync.app.network.dto.MixTimelineSegment> {
    val result = mutableListOf<com.pacesync.app.network.dto.MixTimelineSegment>()
    for (t in tracks) {
        val segName = t.segment ?: ""
        val mixTrack = com.pacesync.app.network.dto.MixTrack(
            uri = t.uri ?: "", name = t.name, artist = t.artist,
            startsAt = "${(t.startsAtSec / 60).toInt().toString().padStart(2, '0')}:${(t.startsAtSec % 60).toInt().toString().padStart(2, '0')}",
            durationSec = t.durationSec, tempo = t.tempo ?: 0.0, camelot = null, energy = t.energy ?: 0.0,
        )
        val last = result.lastOrNull()
        if (last != null && last.segment == segName) {
            result[result.lastIndex] = last.copy(tracks = last.tracks + mixTrack)
        } else {
            result.add(com.pacesync.app.network.dto.MixTimelineSegment(segment = segName, targetBpm = null, targetPaceSec = t.targetPaceSec, tracks = listOf(mixTrack)))
        }
    }
    return result
}

private const val MIN_SPAN_SEC = 30.0

// Horizontal inset shared by the chart's plot area and the segment/track
// strips so all three use one x axis. Zero: everything runs edge to edge,
// with the pace/BPM axis labels drawn over the plot.
private const val CHART_SIDE_PAD = 0f

@Composable
fun PaceChartScreen(api: PaceSyncApi, mixBuildClient: com.pacesync.app.network.MixBuildClient, date: String, title: String, onBack: () -> Unit) {
    // Force landscape for this screen only — every other screen is locked
    // to portrait (manifest android:screenOrientation="portrait"), restored
    // explicitly back to portrait here when this screen leaves composition
    // rather than "previous" (which could read back as UNSPECIFIED on some
    // API levels instead of the manifest's actual portrait lock).
    val context = LocalContext.current
    DisposableEffect(Unit) {
        val activity = context as? Activity
        activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        onDispose {
            activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        }
    }

    // Re-fetches rather than threading List<HistoryTrack> through nav args —
    // same pattern MixBuildScreen uses for segments (cheap, avoids URL-
    // encoding a whole track list).
    var tracks by remember { mutableStateOf<List<HistoryTrack>?>(null) }
    LaunchedEffect(date, title) {
        runCatching { api.getTodaysRunHistory(date, title) }
            .onSuccess { resp -> if (resp.isSuccessful) tracks = resp.body()?.entry?.tracks ?: emptyList() }
            .onFailure { tracks = emptyList() }
    }

    val resolvedTracks = tracks
    if (resolvedTracks == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        return
    }

    if (resolvedTracks.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("No tracklist to chart.", color = MaterialTheme.colorScheme.secondary)
        }
        return
    }

    val totalSec = resolvedTracks.maxOf { it.startsAtSec + it.durationSec }
    val segments = remember(resolvedTracks) { resolvedTracks.map { it.segment ?: "" }.distinct() }

    // Multi-select for "AI Remix" — mirrors DashboardClient.tsx's
    // chartSelectedUris: tapping a chip while in select mode toggles it,
    // 2+ selected enables remix. The selection must be a CONTIGUOUS run of
    // tracks (same constraint as web) since the remix replaces one
    // start..end span in place — a gap would silently fold an unselected
    // track's duration into the budget sent to the mixer.
    var selectMode by remember { mutableStateOf(false) }
    var selectedUris by remember { mutableStateOf<Set<String>>(emptySet()) }
    var remixBpmPrompt by remember { mutableStateOf(false) }
    var multiQuickSwapBpmPrompt by remember { mutableStateOf(false) }
    var remixing by remember { mutableStateOf(false) }
    var remixStatus by remember { mutableStateOf<String?>(null) }
    var remixError by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    // Edits (AI Remix, Quick Swap) apply to local state immediately but are
    // NOT auto-saved — an explicit Save (top-bar icon) is required, per the
    // user's explicit choice, matching "amend then save" rather than every
    // edit silently persisting on its own.
    var dirty by remember { mutableStateOf(false) }
    val remixScope = rememberCoroutineScope()

    fun saveMix(tracksToSave: List<HistoryTrack>) {
        saving = true
        remixScope.launch {
            runCatching {
                val totalSecSave = tracksToSave.maxOf { it.startsAtSec + it.durationSec }
                val timeline = buildTimelineFromTracks(tracksToSave)
                api.pinMix(com.pacesync.app.network.dto.PinMixRequest(date = date, workoutTitle = title, totalSec = totalSecSave, timeline = timeline))
            }.onSuccess { resp ->
                if (resp.isSuccessful) {
                    dirty = false
                } else {
                    remixError = "Save failed (${resp.code()})"
                }
            }.onFailure { remixError = it.message ?: "Save failed" }
            saving = false
        }
    }

    // Splices a picked track list (from either AI Remix or multi-swap) into
    // the flat list in place of [startIdx, endIdx], recomputing
    // startsAtSec for everything after the splice point — same net effect
    // as the web app's spliceMixTracks, flattened for HistoryTrack's
    // non-segmented shape.
    fun spliceTracks(startIdx: Int, endIdx: Int, picked: List<com.pacesync.app.network.dto.MixTrack>): List<HistoryTrack> {
        val before = resolvedTracks.subList(0, startIdx)
        val after = resolvedTracks.subList(endIdx + 1, resolvedTracks.size)
        val replacedSegment = resolvedTracks[startIdx].segment
        var cursorSec = before.lastOrNull()?.let { it.startsAtSec + it.durationSec } ?: 0.0
        val spliced = picked.map { t ->
            val track = HistoryTrack(
                uri = t.uri, name = t.name, artist = t.artist,
                startsAtSec = cursorSec, durationSec = t.durationSec,
                targetPaceSec = resolvedTracks[startIdx].targetPaceSec,
                segment = replacedSegment, tempo = t.tempo, energy = t.energy,
            )
            cursorSec += t.durationSec
            track
        }
        val shiftedAfter = after.map { t ->
            val shifted = t.copy(startsAtSec = cursorSec)
            cursorSec += t.durationSec
            shifted
        }
        return before + spliced + shiftedAfter
    }

    // Returns the selected tracks' [startIdx, endIdx] span, or null (with
    // remixError set) if the selection isn't a contiguous run — shared by
    // AI Remix and multi-select Quick Swap, both of which replace one
    // start..end span in place.
    fun contiguousSelectionSpan(actionLabel: String): Pair<Int, Int>? {
        val indices = resolvedTracks.mapIndexedNotNull { i, t -> if (t.uri != null && selectedUris.contains(t.uri)) i else null }
        if (indices.isEmpty()) return null
        val startIdx = indices.min()
        val endIdx = indices.max()
        if (endIdx - startIdx + 1 != indices.size) {
            remixError = "$actionLabel needs a contiguous selection (no un-selected track skipped in between) — select a run of adjacent tracks and try again."
            return null
        }
        return startIdx to endIdx
    }

    fun runRemix(targetBpm: Int) {
        val (startIdx, endIdx) = contiguousSelectionSpan("AI Remix") ?: return
        val budgetMs = (startIdx..endIdx).sumOf { (resolvedTracks[it].durationSec * 1000).toLong() }
        val avoidUris = resolvedTracks.mapNotNull { it.uri }

        remixing = true
        remixError = null
        remixStatus = "Starting…"
        remixScope.launch {
            val json = Json { ignoreUnknownKeys = true }
            var done: RemixDoneEvent? = null
            var warning: String? = null
            runCatching {
                mixBuildClient.remix(RemixRequest(targetBpm = targetBpm, budgetMs = budgetMs, avoidUris = avoidUris)) { type, element ->
                    when (type) {
                        "progress" -> remixStatus = element.jsonObject["detail"]?.jsonPrimitive?.content
                            ?: element.jsonObject["segment"]?.jsonPrimitive?.content ?: remixStatus
                        "warning" -> warning = element.jsonObject["error"]?.jsonPrimitive?.content
                        "error" -> error(element.jsonObject["error"]?.jsonPrimitive?.content ?: "AI Remix failed")
                        "done" -> {
                            done = runCatching { json.decodeFromJsonElement(RemixDoneEvent.serializer(), element) }.getOrNull()
                        }
                    }
                }
            }.onFailure { remixError = it.message ?: "AI Remix failed" }

            val picked = done?.timeline?.flatMap { it.tracks } ?: emptyList()
            if (picked.isEmpty()) {
                if (remixError == null) remixError = "The AI DJ didn't return any tracks for this BPM/length."
                remixing = false
                return@launch
            }

            tracks = spliceTracks(startIdx, endIdx, picked)
            dirty = true
            selectedUris = emptySet()
            selectMode = false
            if (warning != null) remixError = warning
            remixing = false
            remixStatus = null
        }
    }

    // Multi-select Quick Swap — the non-AI, deterministic counterpart to AI
    // Remix: fills the selection's combined duration with exact-BPM
    // library tracks (api/tracks/replace-candidates-budget), rather than
    // an LLM picking replacements. Same contiguous-selection requirement
    // and splice-in-place as AI Remix.
    fun runMultiQuickSwap(targetBpm: Int) {
        val (startIdx, endIdx) = contiguousSelectionSpan("Quick Swap") ?: return
        val budgetMs = (startIdx..endIdx).sumOf { (resolvedTracks[it].durationSec * 1000).toLong() }
        val excludeUris = resolvedTracks.mapNotNull { it.uri }

        remixing = true
        remixError = null
        remixStatus = "Searching…"
        remixScope.launch {
            val json = Json { ignoreUnknownKeys = true }
            var done: com.pacesync.app.network.dto.ReplaceCandidatesBudgetDoneEvent? = null
            runCatching {
                mixBuildClient.replaceCandidatesBudget(
                    com.pacesync.app.network.dto.ReplaceCandidatesBudgetRequest(targetBpm = targetBpm, budgetMs = budgetMs, excludeUris = excludeUris),
                ) { type, element ->
                    when (type) {
                        "error" -> error(element.jsonObject["error"]?.jsonPrimitive?.content ?: "Quick Swap failed")
                        "done" -> done = runCatching { json.decodeFromJsonElement(com.pacesync.app.network.dto.ReplaceCandidatesBudgetDoneEvent.serializer(), element) }.getOrNull()
                    }
                }
            }.onFailure { remixError = it.message ?: "Quick Swap failed" }

            val picked = done?.tracks?.mapNotNull { c ->
                val uri = c.uri ?: return@mapNotNull null
                com.pacesync.app.network.dto.MixTrack(
                    uri = uri, name = c.name, artist = c.artist, startsAt = "00:00",
                    durationSec = (c.durationMs ?: 0L) / 1000.0, tempo = c.tempo, camelot = null, energy = 0.0,
                )
            } ?: emptyList()
            if (picked.isEmpty()) {
                if (remixError == null) remixError = "No library tracks found at this BPM to fill the selection."
                remixing = false
                remixStatus = null
                return@launch
            }

            tracks = spliceTracks(startIdx, endIdx, picked)
            dirty = true
            selectedUris = emptySet()
            selectMode = false
            done?.warning?.let { remixError = it }
            remixing = false
            remixStatus = null
        }
    }

    // Quick Swap — single-track, library-only exact-BPM replacement
    // (DashboardClient.tsx's QuickSwapModal default: no artist/genre
    // search, no online top-up). Picking a candidate replaces that one
    // track in place and marks the mix dirty, same as a remix edit.
    var quickSwapTarget by remember { mutableStateOf<HistoryTrack?>(null) }
    var quickSwapCandidates by remember { mutableStateOf<List<com.pacesync.app.network.dto.ReplaceCandidate>?>(null) }
    var quickSwapLoading by remember { mutableStateOf(false) }
    var quickSwapError by remember { mutableStateOf<String?>(null) }

    fun openQuickSwap(track: HistoryTrack) {
        val uri = track.uri ?: return
        val tempo = track.tempo ?: return
        quickSwapTarget = track
        quickSwapCandidates = null
        quickSwapError = null
        quickSwapLoading = true
        remixScope.launch {
            val json = Json { ignoreUnknownKeys = true }
            var done: com.pacesync.app.network.dto.ReplaceCandidatesDoneEvent? = null
            runCatching {
                mixBuildClient.replaceCandidates(
                    com.pacesync.app.network.dto.ReplaceCandidatesRequest(
                        targetBpm = chartBpm(tempo),
                        targetUri = uri,
                        excludeUris = resolvedTracks.mapNotNull { it.uri },
                        originalDurationMs = (track.durationSec * 1000).toLong(),
                    ),
                ) { type, element ->
                    when (type) {
                        "error" -> error(element.jsonObject["error"]?.jsonPrimitive?.content ?: "Search failed")
                        "done" -> done = runCatching { json.decodeFromJsonElement(com.pacesync.app.network.dto.ReplaceCandidatesDoneEvent.serializer(), element) }.getOrNull()
                    }
                }
            }.onFailure { quickSwapError = it.message ?: "Search failed" }
            quickSwapCandidates = done?.candidates ?: emptyList()
            quickSwapLoading = false
        }
    }

    fun applyQuickSwap(candidate: com.pacesync.app.network.dto.ReplaceCandidate) {
        val target = quickSwapTarget ?: return
        val uri = candidate.uri ?: return
        tracks = resolvedTracks.map { t ->
            if (t === target) {
                t.copy(uri = uri, name = candidate.name, artist = candidate.artist, tempo = candidate.tempo)
            } else t
        }
        dirty = true
        quickSwapTarget = null
        quickSwapCandidates = null
    }

    // No in-app back control at all — the phone's own system back gesture/
    // button already pops the nav stack, and every row of header chrome
    // steals space the chart/strips badly need on a short landscape screen
    // (confirmed: the track strip was being pushed off-screen when zoomed).
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().padding(horizontal = 12.dp, vertical = 4.dp)) {

        // The shared time window — null means "fully zoomed out" (whole
        // mix visible), matching MixPaceChart.tsx's own `xDomain: [number,
        // number] | null` convention.
        var visibleStart by remember { mutableFloatStateOf(0f) }
        var visibleEnd by remember(totalSec) { mutableFloatStateOf(totalSec.toFloat()) }
        // Tap-to-inspect — mirrors the web chart's Recharts Tooltip: tapping
        // the chart drops a vertical reference line at that x, highlights
        // the pace/BPM step values there, and shows a label box. Cleared
        // whenever the visible window changes (pan/zoom), same as a fresh
        // hover position invalidating the old one.
        var tapTimeSec by remember { mutableStateOf<Double?>(null) }

        // Play/pause control, right-aligned on the legend row — mirrors
        // whatever's actually happening on the active Spotify device
        // (polled, since the Web API has no push notification for this),
        // rather than assuming local app state matches remote reality.
        val headerScope = rememberCoroutineScope()
        var isPlaying by remember { mutableStateOf(false) }
        var hasDevice by remember { mutableStateOf(false) }
        var playingTrackUri by remember { mutableStateOf<String?>(null) }
        var progressMs by remember { mutableStateOf(0L) }
        var durationMs by remember { mutableStateOf(0L) }
        // While the user is actively dragging/tapping the seek box, the
        // next poll's progressMs would otherwise overwrite their gesture
        // with stale server data before the seek call lands — suppressed
        // for a short window after a seek is sent.
        var seekSuppressedUntil by remember { mutableStateOf(0L) }
        LaunchedEffect(Unit) {
            while (true) {
                runCatching { api.getPlaybackState() }
                    .onSuccess { resp ->
                        resp.body()?.let {
                            isPlaying = it.isPlaying
                            hasDevice = it.hasDevice
                            playingTrackUri = it.trackUri
                            if (System.currentTimeMillis() >= seekSuppressedUntil) {
                                progressMs = it.progressMs
                                durationMs = it.durationMs
                            }
                        }
                    }
                delay(2000)
            }
        }

        // Local progress ticker — advances between polls via elapsed time
        // (the server is only polled every 2s, which would otherwise look
        // visibly stepped rather than a smooth bar), resynced to the
        // server's real progressMs on every poll.
        var localProgressMs by remember(progressMs) { mutableStateOf(progressMs) }
        LaunchedEffect(progressMs, isPlaying) {
            val tickStart = System.currentTimeMillis()
            while (isPlaying) {
                delay(100)
                localProgressMs = (progressMs + (System.currentTimeMillis() - tickStart)).coerceAtMost(durationMs)
            }
        }
        val showSeekBar = isPlaying && hasDevice && playingTrackUri != null && durationMs > 0

        // Fixed height — TextButton has more built-in padding than the
        // plain LegendDot row, so without a fixed height the whole chart
        // below would shift down the moment "Reset zoom" appears (confirmed
        // from a real screenshot: the header visibly grew on zoom).
        Row(
            modifier = Modifier.height(32.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                LegendDot(MaterialTheme.colorScheme.primary, "Target pace")
                LegendDot(Color(0xFFF59E0B), "BPM")
                if (visibleStart > 0f || visibleEnd < totalSec.toFloat()) {
                    TextButton(
                        onClick = { visibleStart = 0f; visibleEnd = totalSec.toFloat() },
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp, vertical = 0.dp),
                    ) {
                        Text("Reset zoom", style = MaterialTheme.typography.labelLarge)
                    }
                }
            }

            // Now-playing seek bar — inline between "Reset zoom" and the
            // play/pause icon, only while a track is actually playing (a
            // paused/no-device state has nothing meaningful to show or
            // seek). Time labels at each end show elapsed/total.
            if (showSeekBar) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    modifier = Modifier.weight(1f).padding(horizontal = 12.dp),
                ) {
                    Text(fmtMs(localProgressMs), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary)
                    Box(
                        Modifier
                            .weight(1f)
                            .height(20.dp)
                            .pointerInput(durationMs) {
                                detectTapGestures { pos ->
                                    val frac = (pos.x / size.width).coerceIn(0f, 1f)
                                    val targetMs = (frac * durationMs).toLong()
                                    localProgressMs = targetMs
                                    seekSuppressedUntil = System.currentTimeMillis() + 2500
                                    headerScope.launch {
                                        runCatching { api.playbackAction(PlaybackActionRequest("seek", positionMs = targetMs)) }
                                            .onSuccess { resp -> if (resp.isSuccessful) progressMs = targetMs }
                                    }
                                }
                            },
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        Box(
                            Modifier
                                .fillMaxWidth()
                                .height(6.dp)
                                .clip(RoundedCornerShape(3.dp))
                                .background(MaterialTheme.colorScheme.outlineVariant),
                        ) {
                            val frac = (localProgressMs.toFloat() / durationMs.toFloat()).coerceIn(0f, 1f)
                            Box(
                                Modifier
                                    .fillMaxWidth(frac)
                                    .fillMaxHeight()
                                    .clip(RoundedCornerShape(3.dp))
                                    .background(MaterialTheme.colorScheme.primary),
                            )
                        }
                    }
                    Text(fmtMs(durationMs), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary)
                }
            }

            // Save — only shown once an edit (AI Remix, Quick Swap) has
            // made the in-memory tracklist diverge from what's pinned
            // server-side. Explicit tap required; edits are never
            // auto-saved.
            if (dirty) {
                Icon(
                    Icons.Filled.Save,
                    contentDescription = "Save changes",
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier
                        .padding(end = 10.dp)
                        .size(28.dp)
                        .clip(RoundedCornerShape(4.dp))
                        .clickable(enabled = !saving) { saveMix(resolvedTracks) },
                )
            }

            // Always shown, even with no active device yet — hiding it
            // entirely until a device appears looked like the control was
            // just missing/broken. With no device, resume has nothing to
            // resume, so that case surfaces a toast instead of silently
            // doing nothing.
            //
            // A plain clickable Icon, not IconButton — IconButton enforces
            // a 48dp minimum touch target internally regardless of any
            // size() modifier passed to it, which inside this row's fixed
            // 32dp height was causing it to not lay out at all (confirmed
            // from a real screenshot: totally blank space where the icon
            // should be, not just misplaced).
            Icon(
                if (isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                contentDescription = if (isPlaying) "Pause" else "Play",
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier
                    .size(28.dp)
                    .clip(RoundedCornerShape(4.dp))
                    .clickable {
                        headerScope.launch {
                            if (!hasDevice) {
                                android.widget.Toast.makeText(context, "Open Spotify on a device first", android.widget.Toast.LENGTH_SHORT).show()
                                return@launch
                            }
                            val action = if (isPlaying) "pause" else "resume"
                            runCatching { api.playbackAction(PlaybackActionRequest(action)) }
                                .onSuccess { resp -> if (resp.isSuccessful) isPlaying = !isPlaying }
                        }
                    },
            )
        }

        // Pinch-to-zoom (two fingers) and drag-to-pan (one finger), applied
        // over the whole chart+strips block so the gesture area isn't
        // limited to just the thin chart canvas. detectTransformGestures
        // gives pan/zoom/rotation together; rotation is ignored (gestureZoom
        // already handles pinch, gesturePan handles one-finger drag).
        Column(
            Modifier
                .fillMaxWidth()
                .padding(top = 4.dp)
                .pointerInput(totalSec) {
                    detectTransformGestures { centroid, pan, zoom, _ ->
                        tapTimeSec = null
                        val spanNow = visibleEnd - visibleStart
                        val widthPx = (size.width - 2 * CHART_SIDE_PAD).takeIf { it > 0 } ?: return@detectTransformGestures
                        // Convert the centroid's screen-space x into a
                        // seconds-space anchor so zoom keeps that point
                        // stationary (pinch-zoom should zoom toward where
                        // your fingers are, not always the left edge).
                        val anchorSec = visibleStart + ((centroid.x - CHART_SIDE_PAD) / widthPx).coerceIn(0f, 1f) * spanNow
                        var newSpan = (spanNow / zoom.coerceAtLeast(0.01f)).coerceIn(MIN_SPAN_SEC.toFloat(), totalSec.toFloat())
                        val anchorFrac = (anchorSec - visibleStart) / spanNow.coerceAtLeast(0.001f)
                        var newStart = anchorSec - anchorFrac * newSpan
                        // One-finger pan shifts the window directly in
                        // seconds-space (pan.x is in px — convert via the
                        // CURRENT span/width, before the zoom changes it).
                        newStart -= (pan.x / widthPx) * spanNow
                        var newEnd = newStart + newSpan
                        if (newStart < 0f) { newEnd -= newStart; newStart = 0f }
                        if (newEnd > totalSec.toFloat()) { newStart -= (newEnd - totalSec.toFloat()); newEnd = totalSec.toFloat() }
                        newStart = newStart.coerceAtLeast(0f)
                        visibleStart = newStart
                        visibleEnd = newEnd
                    }
                },
        ) {
            Box(Modifier.fillMaxWidth().height(190.dp)) {
                PaceBpmChart(
                    resolvedTracks, totalSec, visibleStart.toDouble(), visibleEnd.toDouble(),
                    tapTimeSec = tapTimeSec,
                    onTap = { tapTimeSec = it },
                )
            }

            // Segment strip — ONE merged, labeled block per segment (which
            // can span several tracks underneath), not one block per track.
            // Confirmed against the web chart: "6mi at a conversational
            // pace" is a single wide block covering all its tracks, with
            // the segment's own description as its label — the prior
            // per-track-colored-rectangle version drew N same-colored
            // blocks instead of one merged, labeled one.
            val mergedSegments = remember(resolvedTracks) {
                val result = mutableListOf<Triple<String, Double, Double>>() // (segment, startSec, endSec)
                resolvedTracks.forEach { t ->
                    val segName = t.segment ?: ""
                    val tEnd = t.startsAtSec + t.durationSec
                    val last = result.lastOrNull()
                    if (last != null && last.first == segName) {
                        result[result.lastIndex] = Triple(segName, last.second, tEnd)
                    } else {
                        result.add(Triple(segName, t.startsAtSec, tEnd))
                    }
                }
                result
            }
            val segLabelColor = Color.White
            Canvas(Modifier.fillMaxWidth().height(30.dp).padding(top = 6.dp)) {
                val span = (visibleEnd - visibleStart).toDouble().coerceAtLeast(0.001)
                mergedSegments.forEach { (segName, segStart, segEnd) ->
                    val tStart = (segStart - visibleStart).coerceAtLeast(0.0)
                    val tEnd = (segEnd - visibleStart).coerceAtMost(span)
                    if (tEnd <= 0 || tStart >= span) return@forEach
                    val x0 = CHART_SIDE_PAD + (tStart / span).toFloat() * (size.width - 2 * CHART_SIDE_PAD)
                    val x1 = CHART_SIDE_PAD + (tEnd / span).toFloat() * (size.width - 2 * CHART_SIDE_PAD)
                    val w = (x1 - x0).coerceAtLeast(1f)
                    val segColor = SEGMENT_COLORS[segments.indexOf(segName).coerceAtLeast(0) % SEGMENT_COLORS.size]
                    drawRect(segColor.copy(alpha = 0.55f), topLeft = Offset(x0, 0f), size = Size(w, size.height))
                    // A thin divider between adjacent segments so merged
                    // blocks read as distinct spans, not one continuous bar.
                    drawLine(Color.Black.copy(alpha = 0.3f), Offset(x0, 0f), Offset(x0, size.height), strokeWidth = 2f)

                    if (segName.isNotEmpty()) {
                        clipRect(x0, 0f, x1, size.height) {
                            drawContext.canvas.nativeCanvas.apply {
                                val labelPaint = android.graphics.Paint().apply {
                                    color = segLabelColor.toArgb()
                                    textSize = 22f
                                    isFakeBoldText = true
                                    isAntiAlias = true
                                    textAlign = android.graphics.Paint.Align.CENTER
                                }
                                drawText(segName, (x0 + x1) / 2, size.height / 2 + 8f, labelPaint)
                            }
                        }
                    }
                }
            }

            // Track strip — widths proportional to each track's time share
            // of the VISIBLE window (not the whole mix), so zooming in
            // widens tracks exactly as the chart above them widens too.
            // Drawn directly on a Canvas, same approach as the segment
            // strip above — Compose's fillMaxWidth(fraction)/weight don't
            // give a clean way to both size AND position a child at an
            // arbitrary start offset within a Box, and raw Canvas drawing
            // has already proven reliable elsewhere in this screen.
            TrackStrip(
                resolvedTracks, visibleStart.toDouble(), visibleEnd.toDouble(), context, api,
                playingTrackUri = if (isPlaying) playingTrackUri else null,
                selectMode = selectMode,
                selectedUris = selectedUris,
                onToggleSelect = { uri ->
                    selectedUris = if (selectedUris.contains(uri)) selectedUris - uri else selectedUris + uri
                },
                onEnterSelectMode = { uri -> selectMode = true; selectedUris = setOf(uri) },
                onExitSelectMode = { selectMode = false; selectedUris = emptySet() },
                onRequestRemix = { remixBpmPrompt = true },
                onRequestMultiQuickSwap = { multiQuickSwapBpmPrompt = true },
                onQuickSwap = { track -> openQuickSwap(track) },
            )
        }
        }

        if (remixBpmPrompt) {
            RemixBpmDialog(
                selectedCount = selectedUris.size,
                title = "AI Remix",
                description = "The AI DJ will pick library tracks at this BPM to fill these tracks' combined length.",
                onDismiss = { remixBpmPrompt = false },
                onConfirm = { bpm -> remixBpmPrompt = false; runRemix(bpm) },
            )
        }

        if (multiQuickSwapBpmPrompt) {
            RemixBpmDialog(
                selectedCount = selectedUris.size,
                title = "Quick Swap",
                description = "Searches your library for exact-BPM tracks to fill these tracks' combined length (no AI — closest-fit match).",
                onDismiss = { multiQuickSwapBpmPrompt = false },
                onConfirm = { bpm -> multiQuickSwapBpmPrompt = false; runMultiQuickSwap(bpm) },
            )
        }

        if (quickSwapTarget != null) {
            QuickSwapDialog(
                target = quickSwapTarget!!,
                candidates = quickSwapCandidates,
                loading = quickSwapLoading,
                error = quickSwapError,
                onDismiss = { quickSwapTarget = null; quickSwapCandidates = null },
                onPick = ::applyQuickSwap,
            )
        }

        if (remixing || saving) {
            Box(Modifier.align(Alignment.BottomEnd).padding(16.dp)) {
                Row(
                    modifier = Modifier
                        .clip(RoundedCornerShape(10.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant)
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    Text(remixStatus ?: if (saving) "Saving…" else "AI DJ is picking tracks…", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        remixError?.let { err ->
            Box(Modifier.align(Alignment.BottomEnd).padding(16.dp)) {
                Row(
                    modifier = Modifier
                        .clip(RoundedCornerShape(10.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant)
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(err, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    Text(
                        "Dismiss",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.clickable { remixError = null },
                    )
                }
            }
        }
    }
}

@Composable
private fun RemixBpmDialog(selectedCount: Int, title: String, description: String, onDismiss: () -> Unit, onConfirm: (Int) -> Unit) {
    var bpmText by remember { mutableStateOf("") }
    androidx.compose.ui.window.Dialog(onDismissRequest = onDismiss) {
        Box(
            Modifier
                .clip(RoundedCornerShape(12.dp))
                .background(MaterialTheme.colorScheme.surface)
                .padding(16.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("$title $selectedCount tracks", style = MaterialTheme.typography.titleSmall)
                androidx.compose.material3.OutlinedTextField(
                    value = bpmText,
                    onValueChange = { bpmText = it.filter(Char::isDigit) },
                    label = { Text("Target BPM") },
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Number),
                    singleLine = true,
                )
                Text(
                    description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.secondary,
                )
                androidx.compose.material3.Button(
                    onClick = { bpmText.toIntOrNull()?.takeIf { it > 0 }?.let(onConfirm) },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(title)
                }
            }
        }
    }
}

// Library-only quick-swap picker — DashboardClient.tsx's QuickSwapModal
// default behavior (no artist/genre search, no online top-up): a list of
// exact-BPM, duration-matched library candidates for the one selected
// track, tap one to swap it in.
@Composable
private fun QuickSwapDialog(
    target: HistoryTrack,
    candidates: List<com.pacesync.app.network.dto.ReplaceCandidate>?,
    loading: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onPick: (com.pacesync.app.network.dto.ReplaceCandidate) -> Unit,
) {
    androidx.compose.ui.window.Dialog(onDismissRequest = onDismiss) {
        Box(
            Modifier
                .clip(RoundedCornerShape(12.dp))
                .background(MaterialTheme.colorScheme.surface)
                .padding(16.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Quick Swap — ${target.name}", style = MaterialTheme.typography.titleSmall)
                when {
                    loading -> Box(Modifier.fillMaxWidth().padding(vertical = 24.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                    error != null -> Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    candidates.isNullOrEmpty() -> Text(
                        "No library tracks found at this exact BPM / duration.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.secondary,
                    )
                    else -> {
                        val originalMs = (target.durationSec * 1000).toLong()
                        val sorted = candidates.sortedBy { c -> c.durationMs?.let { kotlin.math.abs(it - originalMs) } ?: Long.MAX_VALUE }
                        androidx.compose.foundation.lazy.LazyColumn(
                            Modifier.fillMaxWidth().height(260.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            items(sorted) { c ->
                                val diffSec = c.durationMs?.let { ((it - originalMs) / 1000.0).roundToInt() }
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .clip(RoundedCornerShape(6.dp))
                                        .background(MaterialTheme.colorScheme.surfaceVariant)
                                        .clickable { onPick(c) }
                                        .padding(10.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                ) {
                                    Column(Modifier.weight(1f)) {
                                        Text(c.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                                        Text(
                                            "${c.artist} · ${c.effectiveBpm.roundToInt()} BPM",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.secondary,
                                            maxLines = 1,
                                        )
                                    }
                                    if (diffSec != null) {
                                        Text(
                                            when {
                                                diffSec == 0 -> "±0s"
                                                diffSec > 0 -> "+${diffSec}s"
                                                else -> "${diffSec}s"
                                            },
                                            style = MaterialTheme.typography.labelMedium,
                                            color = MaterialTheme.colorScheme.primary,
                                            modifier = Modifier.padding(start = 8.dp),
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun LegendDot(color: Color, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier
                .width(10.dp)
                .height(10.dp)
                .clip(RoundedCornerShape(5.dp))
                .background(color),
        )
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary, modifier = Modifier.padding(start = 6.dp))
    }
}

// Starts the track on the user's active Spotify device via the backend's
// Web-API-backed play endpoint — NOT an Intent.ACTION_VIEW launch of the
// Spotify app, which would bring Spotify to the foreground and push
// PaceSync behind it. The Web API can only command an EXISTING Spotify
// session though, not launch the app itself — on first use (nothing
// playing anywhere yet) the server replies 409 ("no active device"). That
// specific case falls back to a one-time local launch (bringing Spotify to
// the foreground just this once) purely to register it as an active
// device; every call after that one goes through the remote endpoint and
// PaceSync stays in front.
// contextUri: a playlist to play the track from, so Spotify carries on to the next song in it
// (the server only uses it if the playlist really holds the track).
internal suspend fun playOnActiveDevice(context: android.content.Context, api: PaceSyncApi, uri: String, contextUri: String? = null) {
    val result = runCatching { api.playTrack(PlayRequest(uri, contextUri)) }
    val response = result.getOrNull()
    when {
        response?.isSuccessful == true -> {
            // Spotify answers "OK" to a play command even when the phone's Spotify app is
            // asleep and ignores it (Android puts it to sleep in the background): the
            // current song stops and nothing starts. So check the track really started,
            // and if not, wake Spotify with a one-off launch and send the command again.
            if (!playbackStarted(api, uri)) {
                runCatching {
                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
                android.widget.Toast.makeText(context, "Waking Spotify…", android.widget.Toast.LENGTH_SHORT).show()
                kotlinx.coroutines.delay(2500)
                runCatching { api.playTrack(PlayRequest(uri, contextUri)) }
            }
        }
        response?.code() == 409 -> {
            runCatching {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            android.widget.Toast.makeText(context, "Opening Spotify to start playback…", android.widget.Toast.LENGTH_SHORT).show()
        }
        // Say what actually failed: a server or Spotify error is not "couldn't reach the server".
        response != null -> {
            val detail = response.errorBody()?.string()?.let {
                runCatching { kotlinx.serialization.json.Json.parseToJsonElement(it).jsonObject["error"]?.jsonPrimitive?.content }.getOrNull()
            }
            android.widget.Toast.makeText(context, detail ?: "Playback failed (${response.code()})", android.widget.Toast.LENGTH_LONG).show()
        }
        else -> android.widget.Toast.makeText(context, "Couldn't reach PaceSync server", android.widget.Toast.LENGTH_SHORT).show()
    }
}

// True once Spotify reports `uri` as the playing track - polled for a few seconds, as
// the state takes a moment to catch up after a play command.
private suspend fun playbackStarted(api: PaceSyncApi, uri: String): Boolean {
    repeat(6) {
        kotlinx.coroutines.delay(750)
        val st = runCatching { api.getPlaybackState() }.getOrNull()?.body()
        if (st != null && st.isPlaying && st.trackUri == uri) return true
    }
    return false
}

// Draws each track's name + pace/BPM inside a block whose x-position and
// width exactly match its span on the chart/segment strip above it — same
// visible-window math as PaceBpmChart and the segment strip, so all three
// stay in lockstep under zoom/pan.
//
// Two interaction modes: normal (tap a chip -> long-press-equivalent menu
// with Play in Spotify / Select), and select mode (tap a chip toggles its
// selection with a highlighted ring, matching the web chart's ctrl/cmd-click
// multi-select — entered via the menu's "Select" item, exited via "Done" or
// by emptying the selection).
@Composable
private fun TrackStrip(
    tracks: List<HistoryTrack>,
    visibleStart: Double,
    visibleEnd: Double,
    context: android.content.Context,
    api: PaceSyncApi,
    playingTrackUri: String?,
    selectMode: Boolean,
    selectedUris: Set<String>,
    onToggleSelect: (String) -> Unit,
    onEnterSelectMode: (String) -> Unit,
    onExitSelectMode: () -> Unit,
    onRequestRemix: () -> Unit,
    onRequestMultiQuickSwap: () -> Unit,
    onQuickSwap: (HistoryTrack) -> Unit,
) {
    val chipColor = MaterialTheme.colorScheme.surfaceVariant
    val textColor = MaterialTheme.colorScheme.onSurface
    val selectedColor = MaterialTheme.colorScheme.primary
    // MaterialTheme.colorScheme.secondary is a muted accent and read as
    // low-contrast against the dark chip background (confirmed from a real
    // screenshot) — a plain light gray reads far more clearly here than a
    // themed "secondary" color was ever going to.
    val secondaryColor = Color(0xFFD1D5DB)
    val span = (visibleEnd - visibleStart).coerceAtLeast(0.001)
    val scope = rememberCoroutineScope()
    // Same ordering the segment strip uses to pick SEGMENT_COLORS.
    val segmentNames = remember(tracks) { tracks.map { it.segment ?: "" }.distinct() }

    // Rects are recomputed every frame inside the Canvas draw call (cheap —
    // only as many tracks as are currently visible), but tap/long-press
    // needs them available from the gesture-detector callback too, so
    // they're kept in a small side list updated alongside drawing.
    var trackRects by remember { mutableStateOf<List<Pair<HistoryTrack, androidx.compose.ui.geometry.Rect>>>(emptyList()) }
    var menuTrack by remember { mutableStateOf<HistoryTrack?>(null) }
    var menuOffset by remember { mutableStateOf(Offset.Zero) }

    Box {
        Canvas(
            Modifier
                .fillMaxWidth()
                .height(48.dp)
                .padding(top = 6.dp)
                .pointerInput(tracks, visibleStart, visibleEnd, selectMode) {
                    detectTapGestures(
                        onTap = { pos ->
                            val hit = trackRects.firstOrNull { (_, rect) -> rect.contains(pos) }
                            if (hit == null) return@detectTapGestures
                            if (selectMode) {
                                hit.first.uri?.let(onToggleSelect)
                            } else {
                                menuTrack = hit.first
                                menuOffset = pos
                            }
                        },
                        // Long-press always opens the menu, even while in
                        // select mode — a normal tap there is claimed for
                        // toggling selection, so long-press is the only way
                        // back to "AI Remix"/"Done selecting"/etc without
                        // this (confirmed real bug: select mode had no path
                        // to any other menu item once entered).
                        onLongPress = { pos ->
                            val hit = trackRects.firstOrNull { (_, rect) -> rect.contains(pos) }
                            if (hit != null) {
                                menuTrack = hit.first
                                menuOffset = pos
                            }
                        },
                    )
                },
        ) {
            val gapPx = 3f
            val corner = androidx.compose.ui.geometry.CornerRadius(5.dp.toPx(), 5.dp.toPx())
            // Sizes/baselines in dp/sp scaled to the chip height — raw pixel
            // values crammed both lines into the top of the chip on a
            // high-density screen, overlapping each other.
            val nameSizePx = 11.sp.toPx()
            val detailSizePx = 9.5.sp.toPx()
            val nameBaseline = size.height * 0.42f
            val detailBaseline = size.height * 0.80f
            val rects = mutableListOf<Pair<HistoryTrack, androidx.compose.ui.geometry.Rect>>()
            tracks.forEach { t ->
                val tStart = (t.startsAtSec - visibleStart).coerceAtLeast(0.0)
                val tEnd = (t.startsAtSec + t.durationSec - visibleStart).coerceAtMost(span)
                if (tEnd <= 0 || tStart >= span) return@forEach
                val x0 = CHART_SIDE_PAD + (tStart / span).toFloat() * (size.width - 2 * CHART_SIDE_PAD)
                val x1 = CHART_SIDE_PAD + (tEnd / span).toFloat() * (size.width - 2 * CHART_SIDE_PAD)
                val w = (x1 - x0 - gapPx).coerceAtLeast(1f)
                rects.add(t to androidx.compose.ui.geometry.Rect(Offset(x0, 0f), Size(w, size.height)))

                val isSelected = t.uri != null && selectedUris.contains(t.uri)
                val isPlayingTrack = t.uri != null && t.uri == playingTrackUri
                // Diagonal gradient tinted with the track's segment colour
                // (same palette as the segment strip above), plus a faint
                // light outline so adjacent chips read as separate buttons.
                val segColor = SEGMENT_COLORS[segmentNames.indexOf(t.segment ?: "").coerceAtLeast(0) % SEGMENT_COLORS.size]
                drawRoundRect(
                    brush = androidx.compose.ui.graphics.Brush.linearGradient(
                        listOf(
                            androidx.compose.ui.graphics.lerp(segColor, chipColor, 0.45f),
                            androidx.compose.ui.graphics.lerp(segColor, Color(0xFF0F172A), 0.82f),
                        ),
                        start = Offset(x0, 0f),
                        end = Offset(x0 + w, size.height),
                    ),
                    topLeft = Offset(x0, 0f),
                    size = Size(w, size.height),
                    cornerRadius = corner,
                )
                drawRoundRect(
                    Color.White.copy(alpha = 0.12f),
                    topLeft = Offset(x0, 0f),
                    size = Size(w, size.height),
                    cornerRadius = corner,
                    style = androidx.compose.ui.graphics.drawscope.Stroke(width = 1.dp.toPx()),
                )
                if (isSelected) {
                    drawRoundRect(
                        selectedColor,
                        topLeft = Offset(x0, 0f),
                        size = Size(w, size.height),
                        cornerRadius = corner,
                        style = androidx.compose.ui.graphics.drawscope.Stroke(width = 4f),
                    )
                }
                // Now-playing border — drawn on top of (and independent
                // from) the selection ring, so a track can show both at
                // once without one hiding the other.
                if (isPlayingTrack) {
                    drawRoundRect(
                        Color(0xFFF97316),
                        topLeft = Offset(x0, 0f),
                        size = Size(w, size.height),
                        cornerRadius = corner,
                        style = androidx.compose.ui.graphics.drawscope.Stroke(width = 4f),
                    )
                }

                // Clip text drawing to this chip's own bounds so a long
                // track name never bleeds into the next chip when zoomed in.
                clipRect(x0, 0f, x0 + w, size.height) {
                    drawContext.canvas.nativeCanvas.apply {
                        val namePaint = android.graphics.Paint().apply {
                            color = textColor.toArgb()
                            textSize = nameSizePx
                            isFakeBoldText = true
                            isAntiAlias = true
                        }
                        val detailPaint = android.graphics.Paint().apply {
                            color = secondaryColor.toArgb()
                            textSize = detailSizePx
                            isAntiAlias = true
                        }
                        val textX = x0 + 8.dp.toPx()
                        drawText(t.name, textX, nameBaseline, namePaint)
                        val details = listOfNotNull(
                            t.targetPaceSec?.let { "${fmtPace(it)}/mi" },
                            t.tempo?.let { "${chartBpm(it)} BPM" },
                        ).joinToString(" · ")
                        if (details.isNotEmpty()) drawText(details, textX, detailBaseline, detailPaint)
                    }
                }
            }
            trackRects = rects
        }

        val track = menuTrack
        if (track != null) {
            Box(Modifier.offset { androidx.compose.ui.unit.IntOffset(menuOffset.x.roundToInt(), menuOffset.y.roundToInt()) }) {
                DropdownMenu(expanded = true, onDismissRequest = { menuTrack = null }) {
                    DropdownMenuItem(
                        text = { Text("Play in Spotify") },
                        enabled = track.uri != null,
                        onClick = {
                            menuTrack = null
                            track.uri?.let { uri ->
                                scope.launch { playOnActiveDevice(context, api, uri) }
                            }
                        },
                    )
                    if (!selectMode) {
                        DropdownMenuItem(
                            text = { Text("Quick Swap") },
                            enabled = track.uri != null && track.tempo != null,
                            onClick = {
                                menuTrack = null
                                onQuickSwap(track)
                            },
                        )
                        DropdownMenuItem(
                            text = { Text("Select") },
                            enabled = track.uri != null,
                            onClick = {
                                menuTrack = null
                                track.uri?.let(onEnterSelectMode)
                            },
                        )
                        // Send this track's artist to the Song Crawler (now, or queued behind a crawl in progress).
                        DropdownMenuItem(
                            text = { Text("Lookup artist") },
                            onClick = {
                                menuTrack = null
                                scope.launch {
                                    val msg = lookupArtistInCrawler(api, track.artist)
                                    android.widget.Toast.makeText(context, msg, android.widget.Toast.LENGTH_LONG).show()
                                }
                            },
                        )
                    } else {
                        DropdownMenuItem(
                            text = { Text(if (selectedUris.contains(track.uri)) "Deselect" else "Select") },
                            enabled = track.uri != null,
                            onClick = {
                                menuTrack = null
                                track.uri?.let(onToggleSelect)
                            },
                        )
                        DropdownMenuItem(
                            text = { Text("AI Remix (${selectedUris.size} selected)") },
                            enabled = selectedUris.size >= 2,
                            onClick = {
                                menuTrack = null
                                onRequestRemix()
                            },
                        )
                        DropdownMenuItem(
                            text = { Text("Quick Swap (${selectedUris.size} selected)") },
                            enabled = selectedUris.size >= 2,
                            onClick = {
                                menuTrack = null
                                onRequestMultiQuickSwap()
                            },
                        )
                        DropdownMenuItem(
                            text = { Text("Done selecting") },
                            onClick = {
                                menuTrack = null
                                onExitSelectMode()
                            },
                        )
                    }
                }
            }
        }
    }
}

// Given a step-after series (one (time, value) stop per track start, plus a
// closing stop at the mix's end), returns the value in effect AT time `t` —
// i.e. the most recent stop at-or-before t, matching how the step line
// itself is drawn (flat until the next track's start). Returns null if t is
// before the first stop or the series is empty.
private fun stepValueAt(stops: List<Pair<Double, Double>>, t: Double): Double? {
    var result: Double? = null
    for ((stopT, stopV) in stops) {
        if (stopT > t) break
        result = stopV
    }
    return result
}

// Hand-drawn two-line step chart (target pace + BPM) via Canvas — no
// charting library dependency. Mirrors MixPaceChart.tsx's data shape: one
// point per track start plus a closing point at the end of the last track,
// drawn as step-after curves, clipped to the visible [start, end] window.
// `onTap`/`tapTimeSec` implement the web chart's Recharts Tooltip equivalent:
// tapping the plot area drops a vertical reference line and highlights the
// pace/BPM values in effect at that x, with a floating label box.
@Composable
private fun PaceBpmChart(
    tracks: List<HistoryTrack>,
    totalSec: Double,
    visibleStart: Double,
    visibleEnd: Double,
    tapTimeSec: Double?,
    onTap: (Double) -> Unit,
) {
    val paceColor = MaterialTheme.colorScheme.primary
    val bpmColor = Color(0xFFF59E0B)
    val gridColor = MaterialTheme.colorScheme.outlineVariant
    val cursorColor = MaterialTheme.colorScheme.onSurface
    val labelBg = MaterialTheme.colorScheme.surfaceVariant
    val labelText = MaterialTheme.colorScheme.onSurface

    val paces = tracks.mapNotNull { it.targetPaceSec }
    val bpms = tracks.mapNotNull { it.tempo?.let { t -> chartBpm(t).toDouble() } }
    val paceMin = (paces.minOrNull() ?: 0.0) - 15
    val paceMax = (paces.maxOrNull() ?: 1.0) + 15
    val bpmMin = (bpms.minOrNull() ?: 0.0) - 5
    val bpmMax = (bpms.maxOrNull() ?: 1.0) + 5
    val span = (visibleEnd - visibleStart).coerceAtLeast(0.001)

    val paceStops = tracks.mapNotNull { t -> t.targetPaceSec?.let { t.startsAtSec to it } } +
        listOfNotNull(tracks.lastOrNull()?.targetPaceSec?.let { totalSec to it })
    val bpmStops = tracks.mapNotNull { t -> t.tempo?.let { t.startsAtSec to chartBpm(it).toDouble() } } +
        listOfNotNull(tracks.lastOrNull()?.tempo?.let { totalSec to chartBpm(it).toDouble() })

    Canvas(
        modifier = Modifier
            .fillMaxSize()
            .pointerInput(totalSec, visibleStart, visibleEnd) {
                detectTapGestures { pos ->
                    // Same leftPad/plotWidth math as the draw pass below —
                    // kept in sync by using identical constants.
                    val leftPad = CHART_SIDE_PAD
                    val rightPad = CHART_SIDE_PAD
                    val plotWidth = size.width - leftPad - rightPad
                    if (plotWidth <= 0) return@detectTapGestures
                    val frac = ((pos.x - leftPad) / plotWidth).coerceIn(0f, 1f)
                    onTap(visibleStart + frac * span)
                }
            },
    ) {
        val leftPad = CHART_SIDE_PAD
        val rightPad = CHART_SIDE_PAD
        val topPad = 16f
        val timeLabelSize = 9.sp.toPx()
        // Room under the plot for the cumulative-time labels.
        val bottomPad = 16f + timeLabelSize + 4.dp.toPx()
        val plotWidth = size.width - leftPad - rightPad
        val plotHeight = size.height - topPad - bottomPad
        if (plotWidth <= 0 || plotHeight <= 0 || totalSec <= 0) return@Canvas

        for (i in 0..4) {
            val y = topPad + plotHeight * i / 4
            drawLine(gridColor, Offset(leftPad, y), Offset(leftPad + plotWidth, y), strokeWidth = 1f)
        }

        fun xFor(t: Double): Float = leftPad + ((t - visibleStart) / span).toFloat() * plotWidth
        // Pace is reversed: faster (lower sec/mi) plots HIGHER on screen,
        // matching the web chart (its Y axis shows 8:05 at top, 9:10 at
        // bottom) — confirmed backwards in a prior build (this comment said
        // the right thing, the formula did the opposite).
        fun yForPace(p: Double): Float = topPad + ((p - paceMin) / (paceMax - paceMin)).toFloat().coerceIn(0f, 1f) * plotHeight
        fun yForBpm(b: Double): Float = topPad + ((bpmMax - b) / (bpmMax - bpmMin)).toFloat().coerceIn(0f, 1f) * plotHeight

        fun drawStepLine(stops: List<Pair<Double, Double>>, color: Color, yFor: (Double) -> Float) {
            if (stops.size < 2) return
            for (i in 0 until stops.size - 1) {
                val (t0, v0) = stops[i]
                val (t1, _) = stops[i + 1]
                // Skip segments entirely outside the visible window.
                if (t1 < visibleStart || t0 > visibleEnd) continue
                val x0 = xFor(t0)
                val x1 = xFor(t1)
                val y = yFor(v0)
                drawLine(color, Offset(x0, y), Offset(x1, y), strokeWidth = 4f, cap = StrokeCap.Round)
                if (i + 1 < stops.size) {
                    val yNext = yFor(stops[i + 1].second)
                    drawLine(color, Offset(x1, y), Offset(x1, yNext), strokeWidth = 4f, cap = StrokeCap.Round)
                }
            }
        }

        drawStepLine(paceStops, paceColor) { yForPace(it) }
        drawStepLine(bpmStops, bpmColor) { yForBpm(it) }

        drawContext.canvas.nativeCanvas.apply {
            val paceLabelPaint = android.graphics.Paint().apply {
                color = paceColor.toArgb()
                textSize = 24f
                textAlign = android.graphics.Paint.Align.LEFT
            }
            val bpmLabelPaint = android.graphics.Paint().apply {
                color = bpmColor.toArgb()
                textSize = 24f
                textAlign = android.graphics.Paint.Align.RIGHT
            }
            // Top of the plot is now the FASTEST pace (paceMin) per the
            // flipped yForPace above — labels swapped to match.
            drawText("${fmtPace(paceMin)}", leftPad + 6f, topPad + 8f, paceLabelPaint)
            drawText("${fmtPace((paceMax + paceMin) / 2)}", leftPad + 6f, topPad + plotHeight / 2 + 8f, paceLabelPaint)
            drawText("${fmtPace(paceMax)}", leftPad + 6f, topPad + plotHeight, paceLabelPaint)
            drawText("${bpmMax.roundToInt()}", leftPad + plotWidth - 6f, topPad + 8f, bpmLabelPaint)
            drawText("${((bpmMax + bpmMin) / 2).roundToInt()}", leftPad + plotWidth - 6f, topPad + plotHeight / 2 + 8f, bpmLabelPaint)
            drawText("${bpmMin.roundToInt()}", leftPad + plotWidth - 6f, topPad + plotHeight, bpmLabelPaint)

            // Cumulative time at each track boundary, along the x axis.
            // Labels that would collide with the previous one are skipped —
            // zooming in reveals them.
            val timePaint = android.graphics.Paint().apply {
                color = Color(0xFF9CA3AF).toArgb()
                textSize = timeLabelSize
                textAlign = android.graphics.Paint.Align.CENTER
                isAntiAlias = true
            }
            val tickPaint = android.graphics.Paint().apply {
                color = Color(0xFF9CA3AF).toArgb()
                strokeWidth = 1.dp.toPx()
            }
            val axisY = topPad + plotHeight
            val labelY = axisY + 6.dp.toPx() + timeLabelSize * 0.8f
            val minGap = 6.dp.toPx()
            var lastRight = Float.NEGATIVE_INFINITY
            val boundaries = (tracks.map { it.startsAtSec } + totalSec).distinct()
            for (t in boundaries) {
                if (t < visibleStart || t > visibleEnd) continue
                val x = xFor(t)
                drawLine(x, axisY, x, axisY + 4.dp.toPx(), tickPaint)
                val label = fmtElapsed(t)
                val half = timePaint.measureText(label) / 2
                val cx = x.coerceIn(leftPad + half, leftPad + plotWidth - half)
                if (cx - half < lastRight + minGap) continue
                drawText(label, cx, labelY, timePaint)
                lastRight = cx + half
            }
        }

        // Tap-to-inspect overlay — vertical reference line from the plot's
        // bottom up through both series, a highlighted dot at each
        // intersection, and a floating label box with the exact values.
        if (tapTimeSec != null && tapTimeSec in visibleStart..visibleEnd) {
            val paceAtTap = stepValueAt(paceStops, tapTimeSec)
            val bpmAtTap = stepValueAt(bpmStops, tapTimeSec)
            val x = xFor(tapTimeSec)

            drawLine(cursorColor.copy(alpha = 0.5f), Offset(x, topPad), Offset(x, topPad + plotHeight), strokeWidth = 2f)

            paceAtTap?.let { drawCircle(paceColor, radius = 7f, center = Offset(x, yForPace(it))) }
            bpmAtTap?.let { drawCircle(bpmColor, radius = 7f, center = Offset(x, yForBpm(it))) }

            // Label box — positioned to the right of the tap unless that
            // would overflow the plot, in which case it flips to the left
            // (mirrors Recharts' own Tooltip auto-flip behavior).
            val lines = listOfNotNull(
                paceAtTap?.let { "${fmtPace(it)}/mi target" },
                bpmAtTap?.let { "${it.roundToInt()} BPM" },
            )
            if (lines.isNotEmpty()) {
                val boxWidth = 220f
                val boxHeight = 24f + lines.size * 28f
                val boxX = if (x + 16f + boxWidth > leftPad + plotWidth) x - 16f - boxWidth else x + 16f
                val boxY = topPad + 8f

                drawRoundRect(
                    labelBg,
                    topLeft = Offset(boxX, boxY),
                    size = Size(boxWidth, boxHeight),
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(8f, 8f),
                )
                drawContext.canvas.nativeCanvas.apply {
                    val timePaint = android.graphics.Paint().apply {
                        color = labelText.toArgb()
                        textSize = 22f
                        isFakeBoldText = true
                        isAntiAlias = true
                    }
                    val mm = (tapTimeSec / 60).toInt()
                    val ss = (tapTimeSec % 60).roundToInt()
                    drawText("$mm:${ss.toString().padStart(2, '0')}", boxX + 10f, boxY + 22f, timePaint)
                    lines.forEachIndexed { i, line ->
                        val linePaint = android.graphics.Paint().apply {
                            color = (if (i == 0) paceColor else bpmColor).toArgb()
                            textSize = 22f
                            isAntiAlias = true
                        }
                        drawText(line, boxX + 10f, boxY + 22f + (i + 1) * 26f, linePaint)
                    }
                }
            }
        }
    }
}
