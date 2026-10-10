package com.pacesync.app.ui.schedule

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
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

@Composable
fun ScheduleScreen(api: PaceSyncApi) {
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
            modifier = Modifier.fillMaxSize().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(workouts!!, key = { it.uid }) { w -> WorkoutCard(w) }
        }
    }
}

@Composable
private fun WorkoutCard(workout: RunnaWorkout) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(14.dp)) {
            Text(workout.date, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            Text(workout.title, style = MaterialTheme.typography.titleMedium)
            workout.distanceMi?.let {
                Text("%.1fmi".format(it), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.secondary)
            }
            workout.segments.forEach { seg ->
                Text("• $seg", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
