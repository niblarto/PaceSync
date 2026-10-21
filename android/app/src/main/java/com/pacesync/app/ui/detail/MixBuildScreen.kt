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
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
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
import com.pacesync.app.network.MixBuildClient
import com.pacesync.app.network.PaceSyncApi
import com.pacesync.app.network.dto.MixBuildRequest
import com.pacesync.app.network.dto.MixDoneEvent
import com.pacesync.app.network.dto.PinMixRequest
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// Shown when a scheduled workout has no tracklist yet — triggers an AI DJ
// mix build (app/api/ai-dj/mix, SSE-streamed) with a live progress bar
// matching the web app's own UI, then requires an explicit "Save mix" tap
// before persisting (POST api/ai-dj/pin) — not auto-saved, per the user's
// explicit choice to match the web app's two-step flow.
@Composable
fun MixBuildScreen(
    api: PaceSyncApi,
    mixBuildClient: MixBuildClient,
    date: String,
    title: String,
    onSaved: () -> Unit,
) {
    // Re-fetches the workout (same cheap getWorkouts() re-fetch pattern
    // ActivityDetailScreen uses) to get its segments — avoids threading a
    // List<String> through URL-encoded nav args.
    var segments by remember { mutableStateOf<List<String>?>(null) }
    var segmentsError by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(date, title) {
        runCatching { api.getWorkouts() }
            .onSuccess { resp ->
                if (resp.isSuccessful) {
                    val w = resp.body()?.workouts?.find { it.date == date && it.title == title }
                    // Rest day: the server builds two hours of unplayed songs in
                    // date-added order from these marker lines (lib/rest-day-mix-shared.ts).
                    segments = if (w?.type == "rest") listOf("Rest • 2h - 2h", "Rest day — unplayed songs, oldest added first")
                        else w?.segments ?: emptyList()
                } else {
                    segmentsError = "Failed to load workout (${resp.code()})"
                }
            }
            .onFailure { segmentsError = it.message ?: "Network error" }
    }

    var status by remember { mutableStateOf("Starting…") }
    var current by remember { mutableStateOf(0) }
    var total by remember { mutableStateOf(0) }
    var warnings by remember { mutableStateOf<List<String>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var done by remember { mutableStateOf<MixDoneEvent?>(null) }
    var saving by remember { mutableStateOf(false) }
    var saveError by remember { mutableStateOf<String?>(null) }

    val json = remember { Json { ignoreUnknownKeys = true } }
    val scope = rememberCoroutineScope()

    // Only starts once segments has resolved (non-null) — guards against
    // firing the build with an empty/stale segment list before the workout
    // re-fetch above completes.
    val resolvedSegments = segments
    LaunchedEffect(resolvedSegments) {
        if (resolvedSegments == null) return@LaunchedEffect
        runCatching {
            mixBuildClient.buildMix(MixBuildRequest(title = title, segments = resolvedSegments, date = date)) { type, element ->
                when (type) {
                    "progress" -> {
                        val obj = element.jsonObject
                        current = obj["current"]?.jsonPrimitive?.content?.toIntOrNull() ?: current
                        total = obj["total"]?.jsonPrimitive?.content?.toIntOrNull() ?: total
                        status = obj["segment"]?.jsonPrimitive?.content ?: status
                    }
                    "warning" -> {
                        val obj = element.jsonObject
                        val tracks = obj["tracks"]?.jsonObject?.toString()
                        val llmFailures = obj["llmFailures"]?.jsonObject?.toString()
                        warnings = warnings + listOfNotNull(tracks?.let { "Some tracks missing data" }, llmFailures?.let { "Some segments used a fallback" })
                    }
                    "error" -> {
                        error = element.jsonObject["error"]?.jsonPrimitive?.content ?: "Mix build failed"
                    }
                    "done" -> {
                        // Surface a decode failure as a real error instead of
                        // silently leaving the UI stuck on the last progress
                        // text forever (confirmed real failure mode: a JSON
                        // float decoded into what was then an Int field).
                        val decoded = runCatching { json.decodeFromJsonElement(MixDoneEvent.serializer(), element) }
                        decoded.onSuccess { done = it; status = "Done" }
                            .onFailure { error = "Failed to parse mix result: ${it.message}" }
                    }
                }
            }
        }.onFailure { error = it.message ?: "Mix build failed" }
    }

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        when {
            segmentsError != null -> Text(segmentsError!!, color = MaterialTheme.colorScheme.error)
            error != null -> Text(error!!, color = MaterialTheme.colorScheme.error)
            resolvedSegments == null -> CircularProgressIndicator()
            done == null -> {
                Text("Building mix for \"$title\"…", style = MaterialTheme.typography.titleMedium)
                if (total > 0) {
                    LinearProgressIndicator(progress = { current.toFloat() / total }, modifier = Modifier.fillMaxWidth())
                    Text("$current / $total — $status", style = MaterialTheme.typography.bodySmall)
                } else {
                    CircularProgressIndicator()
                }
            }
            else -> {
                val mix = done!!
                Text("Mix ready — ${mix.trackUris.size} tracks, ${(mix.totalSec / 60).toInt()} min", style = MaterialTheme.typography.titleMedium)
                // Fixed height, not fillMaxSize() — a fillMaxSize() LazyColumn
                // inside this Column claims ALL remaining space regardless
                // of content length, pushing the Save button (and any error
                // text) completely below the visible viewport. This was the
                // real cause of "the mix builds but never gets pinned" — the
                // button was rendered, just permanently off-screen.
                // (ColumnScope.weight() hits an internal-visibility compiler
                // error in this Compose BOM when called from inside a `when`
                // branch — a fixed height sidesteps it entirely.)
                LazyColumn(
                    Modifier.fillMaxWidth().height(320.dp).padding(vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    items(mix.timeline.flatMap { it.tracks }) { track ->
                        Text("${track.name} — ${track.artist}", style = MaterialTheme.typography.bodyMedium)
                    }
                }
                saveError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                Button(
                    onClick = {
                        saving = true
                        scope.launch {
                            runCatching {
                                api.pinMix(PinMixRequest(date = date, workoutTitle = title, totalSec = mix.totalSec, timeline = mix.timeline))
                            }.onSuccess { resp ->
                                if (resp.isSuccessful) onSaved() else { saveError = "Save failed (${resp.code()})"; saving = false }
                            }.onFailure { saveError = it.message ?: "Save failed"; saving = false }
                        }
                    },
                    enabled = !saving,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(if (saving) "Saving…" else "Save mix")
                }
            }
        }
        if (warnings.isNotEmpty()) {
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                Column(Modifier.padding(10.dp)) {
                    warnings.forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
                }
            }
        }
    }
}
