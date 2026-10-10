package com.pacesync.app.ui.detail

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import com.pacesync.app.network.dto.PinRouteRequest
import com.pacesync.app.network.dto.RouteResponse
import com.pacesync.app.network.dto.SimilarActivity
import com.pacesync.app.ui.routes.RouteMapView

// Shown when a scheduled workout has no pinned route yet — lists recent
// GarminDB activities at a matching distance (same source the web app's
// "Runs at the distance…" chips use, app/api/garmin/similar-activities),
// paginated 3-at-a-time to match the web UI's own page size. Tapping an
// activity opens its route on a map FIRST (matching the web app's own
// RouteMapLightbox flow) — pinning is a separate, explicit action from
// there, never automatic on tap.
@Composable
fun RoutePickerScreen(api: PaceSyncApi, date: String, title: String, distanceMi: Double, onPinned: () -> Unit) {
    var activities by remember { mutableStateOf<List<SimilarActivity>?>(null) }
    var total by remember { mutableStateOf(0) }
    var offset by remember { mutableStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }
    var previewing by remember { mutableStateOf<SimilarActivity?>(null) }

    LaunchedEffect(offset) {
        runCatching { api.getSimilarActivities(distanceMi, offset) }
            .onSuccess { resp ->
                if (resp.isSuccessful) {
                    val body = resp.body()
                    activities = body?.activities ?: emptyList()
                    total = body?.total ?: 0
                } else {
                    error = "Failed to load (${resp.code()})"
                }
            }
            .onFailure { error = it.message ?: "Network error" }
    }

    val preview = previewing
    if (preview != null) {
        RoutePreview(
            api = api,
            activity = preview,
            date = date,
            title = title,
            onBack = { previewing = null },
            onPinned = onPinned,
        )
        return
    }

    when {
        error != null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(error!!, color = MaterialTheme.colorScheme.error)
        }
        activities == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        activities!!.isEmpty() && offset == 0 -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("No recent runs near %.1fmi.".format(distanceMi))
        }
        else -> Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            LazyColumn(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(activities!!, key = { it.activity_id }) { activity ->
                    Card(
                        modifier = Modifier.fillMaxWidth().clickable { previewing = activity },
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    ) {
                        Column(Modifier.padding(14.dp)) {
                            Text(
                                activity.name ?: activity.start_time.take(10),
                                style = MaterialTheme.typography.titleMedium,
                            )
                            Text(
                                "${activity.start_time.take(10)} · %.1fmi".format(activity.distance),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.secondary,
                            )
                        }
                    }
                }
            }
            if (total > 3) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Button(onClick = { if (offset >= 3) offset -= 3 }, enabled = offset > 0) { Text("Previous") }
                    Button(onClick = { if (offset + 3 < total) offset += 3 }, enabled = offset + 3 < total) { Text("Next") }
                }
            }
        }
    }
}

// The map preview + explicit pin step — opened after tapping an activity,
// mirrors the web app's RouteMapLightbox (view first, pin is a separate
// button, never automatic).
@Composable
private fun RoutePreview(
    api: PaceSyncApi,
    activity: SimilarActivity,
    date: String,
    title: String,
    onBack: () -> Unit,
    onPinned: () -> Unit,
) {
    var route by remember { mutableStateOf<RouteResponse?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var pinning by remember { mutableStateOf(false) }
    var pinError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(activity.activity_id) {
        runCatching { api.getActivityRoute(activity.activity_id) }
            .onSuccess { resp ->
                if (resp.isSuccessful) route = resp.body() else loadError = "Failed to load route (${resp.code()})"
            }
            .onFailure { loadError = it.message ?: "Network error" }
    }

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(
            activity.name ?: activity.start_time.take(10),
            style = MaterialTheme.typography.titleMedium,
        )
        Text(
            "${activity.start_time.take(10)} · %.1fmi".format(activity.distance),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.secondary,
        )

        when {
            loadError != null -> Text(loadError!!, color = MaterialTheme.colorScheme.error)
            route == null -> Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            else -> Card {
                RouteMapView(route!!.points, modifier = Modifier.fillMaxWidth().height(300.dp))
            }
        }

        pinError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedButton(onClick = onBack, modifier = Modifier.weight(1f)) { Text("Back") }
            Button(
                onClick = {
                    pinning = true
                    pinError = null
                },
                enabled = route != null && !pinning,
                modifier = Modifier.weight(1f),
            ) {
                Text(if (pinning) "Pinning…" else "Pin this route")
            }
        }
    }

    if (pinning) {
        LaunchedEffect(activity.activity_id) {
            runCatching {
                api.pinRoute(
                    PinRouteRequest(
                        date = date,
                        workoutTitle = title,
                        activityId = activity.activity_id,
                        name = route?.name ?: activity.name,
                        distanceMi = activity.distance,
                        runDate = activity.start_time.take(10),
                    ),
                )
            }.onSuccess { resp ->
                if (resp.isSuccessful) onPinned() else { pinError = "Pin failed (${resp.code()})"; pinning = false }
            }.onFailure { pinError = it.message ?: "Pin failed"; pinning = false }
        }
    }
}
