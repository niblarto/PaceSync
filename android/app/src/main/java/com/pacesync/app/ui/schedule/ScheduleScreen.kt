package com.pacesync.app.ui.schedule

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
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
import com.pacesync.app.network.dto.RunnaWorkout
import com.pacesync.app.ui.common.ScrollingBackground
import com.pacesync.app.util.withWeekday

@Composable
fun ScheduleScreen(api: PaceSyncApi, onSelect: (date: String, title: String) -> Unit = { _, _ -> }) {
    var workouts by remember { mutableStateOf<List<RunnaWorkout>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        runCatching { api.getWorkouts() }
            .onSuccess { resp ->
                if (resp.isSuccessful) {
                    workouts = resp.body()?.workouts ?: emptyList()
                } else {
                    error = "Failed to load (${resp.code()})"
                }
            }
            .onFailure { error = it.message ?: "Network error" }
    }

    ScrollingBackground { bgModifier ->
        when {
            error != null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(error!!, color = MaterialTheme.colorScheme.error)
            }
            workouts == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
            workouts!!.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("Nothing scheduled in the next 28 days.")
            }
            else -> LazyColumn(
                modifier = bgModifier.fillMaxSize().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(workouts!!, key = { it.uid }) { w -> WorkoutCard(w, onClick = { onSelect(w.date, w.title) }) }
            }
        }
    }
}

// Shows only date + title + the workout's own one-line summary (e.g.
// "Long Run · 12mi · 1h40m - 1h50m") — NOT the full plan/segment detail,
// which stays hidden until the user taps into the activity-detail screen.
// This matches the web app's own card-collapsed state and avoids dumping
// a strength workout's entire exercise list onto the Schedule list.
//
// The summary line is segments[0] — Runna's own ICS description always
// starts with a "<Type> • <distance> • <duration range>" line before the
// real plan steps (confirmed against the raw feed, e.g.
// "Easy Run • 5mi • 40m - 50m"), so the first segment IS this summary,
// not a plan step — lib/runna-schedule.ts's parseSegments() keeps it as
// segments[0] rather than stripping it out server-side.
@Composable
private fun WorkoutCard(workout: RunnaWorkout, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        // Semi-transparent so the scrolling background shows through.
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.88f)),
    ) {
        Column(Modifier.padding(14.dp)) {
            Text(withWeekday(workout.date), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            Text(workout.title, style = MaterialTheme.typography.titleMedium)
            workout.segments.firstOrNull()?.let { summaryLine ->
                Text(summaryLine, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.secondary)
            }
        }
    }
}
