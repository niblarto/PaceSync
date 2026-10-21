package com.pacesync.app.ui.detail

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.pacesync.app.network.PaceSyncApi
import com.pacesync.app.network.dto.HistoryTrack
import com.pacesync.app.network.dto.RunnaPastRun
import com.pacesync.app.network.dto.RunnaWorkout
import com.pacesync.app.network.dto.UnpinMixRequest
import com.pacesync.app.network.dto.UnpinRouteRequest
import com.pacesync.app.ui.routes.RouteMapView
import com.pacesync.app.util.withWeekday
import kotlinx.coroutines.launch

// Tapping an activity card (Summary's past runs or Schedule's upcoming
// workouts — both link here) shows the day's summary + pinned route +
// tracklist. Re-fetches the workouts list to find the matching (date,
// title) entry rather than threading every field through nav args (avoids
// URL-encoding edge cases for titles containing "/" or other reserved
// chars — only date/title travel through navigation).
//
// A pinned route is a pointer (activityId), not GPS data itself — fetching
// it is a two-step call, same as the web app's own RunnaCard.tsx. Both the
// route and tracklist sections degrade gracefully to "nothing yet" for an
// upcoming (not-yet-run) Schedule entry, rather than erroring.
@Composable
fun ActivityDetailScreen(
    api: PaceSyncApi,
    date: String,
    title: String,
    onPickRoute: (distanceMi: Double) -> Unit = {},
    onBuildMix: () -> Unit = {},
    onShowPaceChart: () -> Unit = {},
) {
    var summary by remember { mutableStateOf<Any?>(null) } // RunnaWorkout or RunnaPastRun
    var tracks by remember { mutableStateOf<List<HistoryTrack>>(emptyList()) }
    var routePoints by remember { mutableStateOf<List<com.pacesync.app.network.dto.RoutePoint>?>(null) }
    var loading by remember { mutableStateOf(true) }
    var routeMenuOpen by remember { mutableStateOf(false) }
    // Satellite vs street map for the route — remembered across screens.
    val mapCtx = androidx.compose.ui.platform.LocalContext.current
    val mapPrefs = remember { mapCtx.getSharedPreferences("route_map", android.content.Context.MODE_PRIVATE) }
    var satellite by remember { mutableStateOf(mapPrefs.getBoolean("satellite", false)) }
    var runNonce by remember { mutableStateOf(0) } // "Run ▶▶" — arrow along the route
    var tracklistMenuOpen by remember { mutableStateOf(false) }
    var confirmTodaysRun by remember { mutableStateOf(false) }
    var savingPlaylist by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = androidx.compose.ui.platform.LocalContext.current

    fun toast(msg: String) = android.widget.Toast.makeText(context, msg, android.widget.Toast.LENGTH_SHORT).show()

    // Same calls as the web dashboard's "Save to Spotify" / "Save to Today's
    // Running Playlist" (DashboardClient.tsx savePlaylist / saveTodaysRun).
    // Creates the playlist, or replaces an existing one's tracks so it always
    // matches this tracklist. Returns the playlist id, or null (after a
    // toast) on failure.
    suspend fun upsertPlaylist(name: String, description: String): String? {
        val uris = tracks.mapNotNull { it.uri }
        if (uris.isEmpty()) return null
        val resp = runCatching { api.createPlaylist(com.pacesync.app.network.dto.CreatePlaylistRequest(name, description, uris)) }
            .getOrElse { toast(it.message ?: "Save failed"); return null }
        val body = resp.body()
        return when {
            !resp.isSuccessful || body?.error != null -> { toast(body?.error ?: "Save failed (${resp.code()})"); null }
            body?.tracksAdded == false -> { toast("Playlist created, but Spotify blocked adding the tracks"); null }
            else -> body?.playlistId ?: body?.url?.substringAfterLast("/")?.substringBefore("?")
        }
    }

    val mixPlaylistName = date.split("-").let { (y, m, d) -> "$d-$m-${y.takeLast(2)} $title" }
    val mixPlaylistDescription = "AI DJ mix for Runna workout \"$title\" — pace-matched to each segment"

    fun saveToSpotify(name: String, description: String, onSaved: suspend () -> Unit = {}) {
        if (savingPlaylist) return
        savingPlaylist = true
        scope.launch {
            if (upsertPlaylist(name, description) != null) { onSaved(); toast("Saved \"$name\" to Spotify") }
            savingPlaylist = false
        }
    }

    // Saves the mix playlist (create or refresh) then plays it from track 1
    // with shuffle off. If no Spotify device is active, opens Spotify on the
    // playlist once to register this phone, then retries so shuffle-off and
    // the start position still get applied.
    fun playTracklistInSpotify() {
        if (savingPlaylist) return
        savingPlaylist = true
        scope.launch {
            val playlistId = upsertPlaylist(mixPlaylistName, mixPlaylistDescription)
            if (playlistId != null) {
                val contextUri = "spotify:playlist:$playlistId"
                val request = com.pacesync.app.network.dto.PlayRequest(contextUri = contextUri)
                val first = runCatching { api.playTrack(request) }.getOrNull()
                when {
                    first?.isSuccessful == true -> toast("Playing \"$mixPlaylistName\"")
                    first?.code() == 409 -> {
                        runCatching {
                            context.startActivity(
                                android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(contextUri))
                                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
                            )
                        }
                        kotlinx.coroutines.delay(4000)
                        runCatching { api.playTrack(request) }
                    }
                    else -> toast("Couldn't start playback")
                }
            }
            savingPlaylist = false
        }
    }

    fun saveTodaysRun() {
        val (y, m, d) = date.split("-")
        saveToSpotify("Today's Run", "$title - $d-$m-$y") {
            runCatching {
                api.saveTodaysRunHistory(com.pacesync.app.network.dto.SaveTodaysRunRequest(date, title, buildTimelineFromTracks(tracks)))
            }
        }
    }

    LaunchedEffect(date, title) {
        loading = true

        // Summary: find the matching entry in the already-fetched-elsewhere
        // workouts list (cheap re-fetch — same endpoint Summary/Schedule use).
        runCatching { api.getWorkouts() }.getOrNull()?.let { resp ->
            if (resp.isSuccessful) {
                val body = resp.body()
                summary = body?.pastRuns?.find { it.date == date && it.title == title }
                    ?: body?.workouts?.find { it.date == date && it.title == title }
            }
        }

        // Tracklist.
        runCatching { api.getTodaysRunHistory(date, title) }.getOrNull()?.let { resp ->
            if (resp.isSuccessful) tracks = resp.body()?.entry?.tracks ?: emptyList()
        }

        // Pinned route — two-step: pointer first, then GPS points if one exists.
        runCatching { api.getPinnedRoute(date, title) }.getOrNull()?.let { resp ->
            if (resp.isSuccessful) {
                val activityId = resp.body()?.route?.activityId
                if (activityId != null) {
                    runCatching { api.getActivityRoute(activityId) }.getOrNull()?.let { routeResp ->
                        if (routeResp.isSuccessful) routePoints = routeResp.body()?.points ?: emptyList()
                    }
                }
            }
        }

        loading = false
    }

    if (loading) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        return
    }

    if (confirmTodaysRun) {
        val (y, m, d) = date.split("-")
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmTodaysRun = false },
            title = { Text("Save to Today's Run?") },
            text = { Text("This mix was built for $d-$m-$y (\"$title\"), not today — save it as today's run anyway?") },
            confirmButton = {
                androidx.compose.material3.TextButton(onClick = { confirmTodaysRun = false; saveTodaysRun() }) { Text("Save") }
            },
            dismissButton = {
                androidx.compose.material3.TextButton(onClick = { confirmTodaysRun = false }) { Text("Cancel") }
            },
        )
    }

    LazyColumn(modifier = Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(withWeekday(date), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                Text(title, style = MaterialTheme.typography.headlineSmall)
                SummaryDetails(summary)
            }
        }

        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Box {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.weight(1f)) {
                            SectionHeader(
                                "Route",
                                interactive = routePoints != null,
                                onPress = { routeMenuOpen = true },
                            )
                        }
                        if (routePoints != null) {
                            androidx.compose.material3.TextButton(onClick = { runNonce++ }) { Text("Run ▶▶") }
                            androidx.compose.material3.TextButton(onClick = {
                                satellite = !satellite
                                mapPrefs.edit().putBoolean("satellite", satellite).apply()
                            }) { Text(if (satellite) "🗺 Map" else "🛰 Satellite") }
                        }
                    }
                    DropdownMenu(expanded = routeMenuOpen, onDismissRequest = { routeMenuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text("Run ▶▶") },
                            onClick = { routeMenuOpen = false; runNonce++ },
                        )
                        DropdownMenuItem(
                            text = { Text("Unpin route") },
                            onClick = {
                                routeMenuOpen = false
                                scope.launch {
                                    runCatching { api.unpinRoute(UnpinRouteRequest(date = date, title = title)) }
                                        .onSuccess { resp -> if (resp.isSuccessful) routePoints = null }
                                }
                            },
                        )
                    }
                }
                if (routePoints == null) {
                    Text("No pinned route for this day.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.secondary)
                    // Only a scheduled (not-yet-run) workout can have a
                    // route picked/pinned from here — a completed run's
                    // route is historical record, matching the web app.
                    val workout = summary as? RunnaWorkout
                    if (workout != null && workout.distanceMi != null) {
                        Button(onClick = { onPickRoute(workout.distanceMi) }) { Text("Pick a route") }
                    }
                } else {
                    // Clipped to rounded corners with an explicit card
                    // boundary so the map reads as its own section rather
                    // than bleeding into the text above/below it. The
                    // osmdroid MapView consumes its own touch events for
                    // pan/zoom, so long-press lives on the title above
                    // instead of on the map itself (confirmed it never
                    // reaches Compose's gesture detector through the map).
                    Card {
                        RouteMapView(routePoints!!, modifier = Modifier.fillMaxWidth().height(260.dp), satellite = satellite, runNonce = runNonce)
                    }
                }
            }
        }

        item {
            Box {
                SectionHeader(
                    "Tracklist",
                    interactive = tracks.isNotEmpty(),
                    onPress = { tracklistMenuOpen = true },
                )
                DropdownMenu(expanded = tracklistMenuOpen, onDismissRequest = { tracklistMenuOpen = false }) {
                    DropdownMenuItem(
                        text = { Text("Play in Spotify") },
                        enabled = !savingPlaylist,
                        onClick = {
                            tracklistMenuOpen = false
                            playTracklistInSpotify()
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Unpin mix") },
                        onClick = {
                            tracklistMenuOpen = false
                            scope.launch {
                                runCatching { api.unpinMix(UnpinMixRequest(date = date, title = title)) }
                                    .onSuccess { resp -> if (resp.isSuccessful) tracks = emptyList() }
                            }
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Remix") },
                        onClick = {
                            tracklistMenuOpen = false
                            onBuildMix()
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Save to Today's Run") },
                        enabled = !savingPlaylist,
                        onClick = {
                            tracklistMenuOpen = false
                            val today = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(java.util.Date())
                            if (date == today) saveTodaysRun()
                            else scope.launch {
                                // No need to ask when today is a rest day or already
                                // has a recorded activity — nothing of today's to overwrite.
                                val body = runCatching { api.getWorkouts() }.getOrNull()?.body()
                                val todayIsFree = body != null && (
                                    body.pastRuns.any { it.date == today } ||
                                        body.workouts.any { it.date == today && it.type == "rest" }
                                    )
                                if (todayIsFree) saveTodaysRun() else confirmTodaysRun = true
                            }
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Save to Spotify") },
                        enabled = !savingPlaylist,
                        onClick = {
                            tracklistMenuOpen = false
                            saveToSpotify(mixPlaylistName, mixPlaylistDescription)
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Pace Chart") },
                        onClick = {
                            tracklistMenuOpen = false
                            onShowPaceChart()
                        },
                    )
                }
            }
        }
        if (savingPlaylist) {
            item { Text("Saving to Spotify…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary) }
        }
        if (tracks.isEmpty()) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("No tracklist for this day.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.secondary)
                    val workout = summary as? RunnaWorkout
                    if (workout != null) {
                        Button(onClick = onBuildMix) { Text(if (workout.type == "rest") "Rest-day mix" else "AI DJ Mix") }
                    }
                }
            }
        } else {
            items(tracks, key = { "${it.uri}-${it.startsAtSec}" }) { track ->
                Column(
                    Modifier
                        .fillMaxWidth()
                        .pointerInput(track.uri) {
                            detectTapGestures(onDoubleTap = {
                                val uri = track.uri ?: return@detectTapGestures
                                scope.launch { playOnActiveDevice(context, api, uri) }
                                toast("Playing ${track.name}")
                            })
                        },
                ) {
                    Text("${track.name} — ${track.artist}", style = MaterialTheme.typography.bodyMedium)
                    HorizontalDivider(Modifier.padding(top = 8.dp))
                }
            }
        }
    }
}

// A section title styled like something tappable — a rounded pill with a
// subtle fill plus a "⋮" overflow hint — rather than plain text, since
// there's no other visual cue that long-pressing it opens a menu.
// `interactive` controls whether the hint/long-press is shown at all (no
// point suggesting a menu before there's a route/mix to unpin).
@Composable
private fun SectionHeader(text: String, interactive: Boolean, onPress: () -> Unit) {
    val background = if (interactive) MaterialTheme.colorScheme.surfaceVariant else androidx.compose.ui.graphics.Color.Transparent
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .clip(RoundedCornerShape(20.dp))
            .background(background)
            .let { if (interactive) it.clickable(onClick = onPress) else it }
            .padding(horizontal = if (interactive) 12.dp else 0.dp, vertical = if (interactive) 6.dp else 0.dp),
    ) {
        Text(text, style = MaterialTheme.typography.titleMedium)
        if (interactive) {
            Icon(
                Icons.Filled.MoreVert,
                contentDescription = "Options",
                modifier = Modifier.padding(start = 4.dp),
                tint = MaterialTheme.colorScheme.secondary,
            )
        }
    }
}

@Composable
private fun SummaryDetails(summary: Any?) {
    val details = when (summary) {
        is RunnaPastRun -> listOfNotNull(
            summary.distanceMi?.let { "%.1fmi".format(it) },
            summary.durationStr,
            summary.avgPace,
        )
        is RunnaWorkout -> listOfNotNull(summary.distanceMi?.let { "%.1fmi".format(it) })
        else -> emptyList()
    }
    if (details.isNotEmpty()) {
        Text(details.joinToString(" · "), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.secondary)
    }
    // Workout (the planned steps) comes first, Laps (real per-split pace,
    // e.g. "5.00 mi @ 8:47 /mi") underneath — per explicit user request.
    if (summary is RunnaWorkout && summary.segments.isNotEmpty()) {
        Column(Modifier.padding(top = 8.dp)) {
            summary.segments.forEach { seg -> Text("• $seg", style = MaterialTheme.typography.bodySmall) }
        }
    }
    if (summary is RunnaPastRun && summary.planSteps.isNotEmpty()) {
        Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("Workout", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.secondary)
            summary.planSteps.forEach { seg -> Text(seg, style = MaterialTheme.typography.bodySmall) }
        }
    }
    if (summary is RunnaPastRun && summary.laps.isNotEmpty()) {
        Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("Laps", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.secondary)
            summary.laps.forEach { lap -> Text(lap, style = MaterialTheme.typography.bodySmall) }
        }
    }
}
