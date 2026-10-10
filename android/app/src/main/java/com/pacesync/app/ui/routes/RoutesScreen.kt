package com.pacesync.app.ui.routes

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
import com.pacesync.app.network.dto.GarminCourse

// Course picker — selecting a course navigates to RouteMapScreen(courseId).
// Garmin-recorded-activity routes aren't separately browsable here in v1
// (no "list my recent activities" endpoint exists yet); courses are what
// /api/garmin/courses already exposes.
@Composable
fun RoutesScreen(api: PaceSyncApi, onSelectCourse: (GarminCourse) -> Unit) {
    var courses by remember { mutableStateOf<List<GarminCourse>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        runCatching { api.getCourses() }
            .onSuccess { resp ->
                if (resp.isSuccessful) {
                    courses = resp.body()?.courses ?: emptyList()
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
        courses == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        courses!!.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("No Garmin courses found.")
        }
        else -> LazyColumn(
            modifier = Modifier.fillMaxSize().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(courses!!, key = { it.id }) { course ->
                Card(
                    modifier = Modifier.fillMaxWidth().clickable { onSelectCourse(course) },
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                ) {
                    Column(Modifier.padding(14.dp)) {
                        Text(course.name, style = MaterialTheme.typography.titleMedium)
                        Text(
                            "%.1fmi".format(course.distanceMi),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.secondary,
                        )
                    }
                }
            }
        }
    }
}
