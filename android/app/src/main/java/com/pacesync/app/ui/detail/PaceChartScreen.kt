package com.pacesync.app.ui.detail

import android.app.Activity
import android.content.Intent
import android.content.pm.ActivityInfo
import android.net.Uri
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.ui.unit.toSize
import com.pacesync.app.network.PaceSyncApi
import com.pacesync.app.network.dto.HistoryTrack
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

private fun fmtPace(secs: Double): String {
    val m = (secs / 60).toInt()
    val s = (secs % 60).roundToInt()
    return "$m:${s.toString().padStart(2, '0')}"
}

private val SEGMENT_COLORS = listOf(
    Color(0xFF34D399), Color(0xFF60A5FA), Color(0xFFF59E0B),
    Color(0xFFF472B6), Color(0xFFA78BFA), Color(0xFF38BDF8),
)

private const val MIN_SPAN_SEC = 30.0

@Composable
fun PaceChartScreen(api: PaceSyncApi, date: String, title: String, onBack: () -> Unit) {
    // Force landscape for this screen only — restored to the system default
    // (SCREEN_ORIENTATION_UNSPECIFIED, i.e. follow the device/sensor again)
    // when the screen leaves composition.
    val context = LocalContext.current
    DisposableEffect(Unit) {
        val activity = context as? Activity
        val previous = activity?.requestedOrientation
        activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        onDispose {
            activity?.requestedOrientation = previous ?: ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
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

        // Fixed height — TextButton has more built-in padding than the
        // plain LegendDot row, so without a fixed height the whole chart
        // below would shift down the moment "Reset zoom" appears (confirmed
        // from a real screenshot: the header visibly grew on zoom).
        Row(
            modifier = Modifier.height(32.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
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
                        val widthPx = size.width.toFloat().takeIf { it > 0 } ?: return@detectTransformGestures
                        // Convert the centroid's screen-space x into a
                        // seconds-space anchor so zoom keeps that point
                        // stationary (pinch-zoom should zoom toward where
                        // your fingers are, not always the left edge).
                        val anchorSec = visibleStart + (centroid.x / widthPx) * spanNow
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
                    val x0 = (tStart / span).toFloat() * size.width
                    val x1 = (tEnd / span).toFloat() * size.width
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
            TrackStrip(resolvedTracks, visibleStart.toDouble(), visibleEnd.toDouble(), context)
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

// Opens a Spotify track URI directly — Android routes spotify:track:<id> to
// the Spotify app if installed, falling back to the Play Store/browser
// otherwise, same as any other app-link Intent.
private fun playInSpotify(context: android.content.Context, uri: String) {
    runCatching {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}

// Draws each track's name + pace/BPM inside a block whose x-position and
// width exactly match its span on the chart/segment strip above it — same
// visible-window math as PaceBpmChart and the segment strip, so all three
// stay in lockstep under zoom/pan. Long-pressing a chip opens a small menu
// anchored at the press point with a "Play in Spotify" action.
@Composable
private fun TrackStrip(tracks: List<HistoryTrack>, visibleStart: Double, visibleEnd: Double, context: android.content.Context) {
    val chipColor = MaterialTheme.colorScheme.surfaceVariant
    val textColor = MaterialTheme.colorScheme.onSurface
    // MaterialTheme.colorScheme.secondary is a muted accent and read as
    // low-contrast against the dark chip background (confirmed from a real
    // screenshot) — a plain light gray reads far more clearly here than a
    // themed "secondary" color was ever going to.
    val secondaryColor = Color(0xFFD1D5DB)
    val span = (visibleEnd - visibleStart).coerceAtLeast(0.001)

    // Rects are recomputed every frame inside the Canvas draw call (cheap —
    // only as many tracks as are currently visible), but long-press needs
    // them available from the gesture-detector callback too, so they're
    // kept in a small side list updated alongside drawing.
    var trackRects by remember { mutableStateOf<List<Pair<HistoryTrack, androidx.compose.ui.geometry.Rect>>>(emptyList()) }
    var menuTrack by remember { mutableStateOf<HistoryTrack?>(null) }
    var menuOffset by remember { mutableStateOf(Offset.Zero) }

    Box {
        Canvas(
            Modifier
                .fillMaxWidth()
                .height(48.dp)
                .padding(top = 6.dp)
                .pointerInput(tracks, visibleStart, visibleEnd) {
                    detectTapGestures(
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
            val rects = mutableListOf<Pair<HistoryTrack, androidx.compose.ui.geometry.Rect>>()
            tracks.forEach { t ->
                val tStart = (t.startsAtSec - visibleStart).coerceAtLeast(0.0)
                val tEnd = (t.startsAtSec + t.durationSec - visibleStart).coerceAtMost(span)
                if (tEnd <= 0 || tStart >= span) return@forEach
                val x0 = (tStart / span).toFloat() * size.width
                val x1 = (tEnd / span).toFloat() * size.width
                val w = (x1 - x0 - gapPx).coerceAtLeast(1f)
                rects.add(t to androidx.compose.ui.geometry.Rect(Offset(x0, 0f), Size(w, size.height)))

                drawRoundRect(
                    chipColor,
                    topLeft = Offset(x0, 0f),
                    size = Size(w, size.height),
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(12f, 12f),
                )

                // Clip text drawing to this chip's own bounds so a long
                // track name never bleeds into the next chip when zoomed in.
                clipRect(x0, 0f, x0 + w, size.height) {
                    drawContext.canvas.nativeCanvas.apply {
                        val namePaint = android.graphics.Paint().apply {
                            color = textColor.toArgb()
                            textSize = 30f
                            isFakeBoldText = true
                            isAntiAlias = true
                        }
                        val detailPaint = android.graphics.Paint().apply {
                            color = secondaryColor.toArgb()
                            textSize = 26f
                            isFakeBoldText = true
                            isAntiAlias = true
                        }
                        val textX = x0 + 10f
                        // Baselines sized to fit a 48dp-tall strip snugly —
                        // was a fixed 64dp with these same two lines at
                        // y=28/54, leaving a visibly empty band below the
                        // text (confirmed from a real screenshot).
                        drawText(t.name, textX, 22f, namePaint)
                        val details = listOfNotNull(
                            t.targetPaceSec?.let { "${fmtPace(it)}/mi" },
                            t.tempo?.let { "${chartBpm(it)} BPM" },
                        ).joinToString(" · ")
                        if (details.isNotEmpty()) drawText(details, textX, 44f, detailPaint)
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
                            track.uri?.let { playInSpotify(context, it) }
                        },
                    )
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
                    val leftPad = 56f
                    val rightPad = 56f
                    val plotWidth = size.width - leftPad - rightPad
                    if (plotWidth <= 0) return@detectTapGestures
                    val frac = ((pos.x - leftPad) / plotWidth).coerceIn(0f, 1f)
                    onTap(visibleStart + frac * span)
                }
            },
    ) {
        val leftPad = 56f
        val rightPad = 56f
        val topPad = 16f
        val bottomPad = 16f
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
                textAlign = android.graphics.Paint.Align.RIGHT
            }
            val bpmLabelPaint = android.graphics.Paint().apply {
                color = bpmColor.toArgb()
                textSize = 24f
                textAlign = android.graphics.Paint.Align.LEFT
            }
            // Top of the plot is now the FASTEST pace (paceMin) per the
            // flipped yForPace above — labels swapped to match.
            drawText("${fmtPace(paceMin)}", leftPad - 6f, topPad + 8f, paceLabelPaint)
            drawText("${fmtPace((paceMax + paceMin) / 2)}", leftPad - 6f, topPad + plotHeight / 2 + 8f, paceLabelPaint)
            drawText("${fmtPace(paceMax)}", leftPad - 6f, topPad + plotHeight, paceLabelPaint)
            drawText("${bpmMax.roundToInt()}", leftPad + plotWidth + 6f, topPad + 8f, bpmLabelPaint)
            drawText("${((bpmMax + bpmMin) / 2).roundToInt()}", leftPad + plotWidth + 6f, topPad + plotHeight / 2 + 8f, bpmLabelPaint)
            drawText("${bpmMin.roundToInt()}", leftPad + plotWidth + 6f, topPad + plotHeight, bpmLabelPaint)
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
