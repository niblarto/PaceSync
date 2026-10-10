package com.pacesync.app.ui.detail

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.pacesync.app.network.PaceSyncApi
import com.pacesync.app.network.dto.HistoryTrack
import com.pacesync.app.network.dto.RunnaPastRun
import com.pacesync.app.network.dto.RunnaWorkout
import com.pacesync.app.ui.routes.RouteMapView
import com.pacesync.app.util.withWeekday

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
fun ActivityDetailScreen(api: PaceSyncApi, date: String, title: String) {
    var summary by remember { mutableStateOf<Any?>(null) } // RunnaWorkout or RunnaPastRun
    var tracks by remember { mutableStateOf<List<HistoryTrack>>(emptyList()) }
    var routePoints by remember { mutableStateOf<List<com.pacesync.app.network.dto.RoutePoint>?>(null) }
    var loading by remember { mutableStateOf(true) }

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
                Text("Route", style = MaterialTheme.typography.titleMedium)
                if (routePoints == null) {
                    Text("No pinned route for this day.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.secondary)
                } else {
                    // Clipped to rounded corners with an explicit card
                    // boundary so the map reads as its own section rather
                    // than bleeding into the text above/below it.
                    Card {
                        RouteMapView(routePoints!!, modifier = Modifier.fillMaxWidth().height(260.dp))
                    }
                }
            }
        }

        item {
            Text("Tracklist", style = MaterialTheme.typography.titleMedium)
        }
        if (tracks.isEmpty()) {
            item {
                Text("No tracklist for this day.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.secondary)
            }
        } else {
            items(tracks, key = { "${it.uri}-${it.startsAtSec}" }) { track ->
                Column {
                    Text("${track.name} — ${track.artist}", style = MaterialTheme.typography.bodyMedium)
                    HorizontalDivider(Modifier.padding(top = 8.dp))
                }
            }
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
    // Laps (real per-split pace, e.g. "5.00 mi @ 8:47 /mi") come before the
    // Workout/plan-steps section, matching the web app's own card order.
    if (summary is RunnaPastRun && summary.laps.isNotEmpty()) {
        Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("Laps", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.secondary)
            summary.laps.forEach { lap -> Text(lap, style = MaterialTheme.typography.bodySmall) }
        }
    }
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
}
