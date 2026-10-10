package com.pacesync.app.ui.summary

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
import com.pacesync.app.network.dto.RunnaPastRun

@Composable
fun SummaryScreen(api: PaceSyncApi) {
    var pastRuns by remember { mutableStateOf<List<RunnaPastRun>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        runCatching { api.getWorkouts() }
            .onSuccess { resp ->
                if (resp.isSuccessful) {
                    pastRuns = resp.body()?.pastRuns ?: emptyList()
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
        pastRuns == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        pastRuns!!.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("Nothing in the last 8 days.")
        }
        else -> LazyColumn(
            modifier = Modifier.fillMaxSize().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(pastRuns!!, key = { it.uid }) { run -> PastRunCard(run) }
        }
    }
}

@Composable
private fun PastRunCard(run: RunnaPastRun) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(14.dp)) {
            Text(run.date, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            Text(run.title, style = MaterialTheme.typography.titleMedium)
            val details = listOfNotNull(
                run.distanceMi?.let { "%.1fmi".format(it) },
                run.durationStr,
                run.avgPace,
            ).joinToString(" · ")
            if (details.isNotEmpty()) {
                Text(details, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.secondary)
            }
        }
    }
}
