package com.pacesync.app.ui.settings

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import com.pacesync.app.health.NutritionSync
import com.pacesync.app.health.NutritionSyncWorker
import com.pacesync.app.health.SyncStatus
import kotlinx.coroutines.delay
import java.text.DateFormat
import java.util.Date

// Lose It! → Health Connect → PaceSync. Lose It! must have Health Connect
// turned on (Profile → Automatic Tracking → Health Connect).
@Composable
fun HealthConnectSection() {
    val context = LocalContext.current
    val sdkStatus = remember { NutritionSync.sdkStatus(context) }

    Text("Nutrition (Lose It! via Health Connect)", style = MaterialTheme.typography.titleMedium)

    if (sdkStatus != HealthConnectClient.SDK_AVAILABLE) {
        Text(
            if (sdkStatus == HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED)
                "Health Connect needs installing or updating."
            else "Health Connect isn't available on this device.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.secondary,
        )
        if (sdkStatus == HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED) {
            OutlinedButton(onClick = { openHealthConnectInStore(context) }, modifier = Modifier.fillMaxWidth()) {
                Text("Get Health Connect")
            }
        }
        return
    }

    val client = remember { NutritionSync.client(context) }
    var granted by remember { mutableStateOf<Set<String>?>(null) }
    var requestable by remember { mutableStateOf<Set<String>>(emptySet()) }
    var sources by remember { mutableStateOf<List<NutritionSync.SourceSummary>?>(null) }
    var lastSync by remember { mutableStateOf(SyncStatus.load(context)) }

    suspend fun refresh() {
        requestable = NutritionSync.permissionsToRequest(client)
        val g = client.permissionController.getGrantedPermissions()
        granted = g
        if (NutritionSync.READ_NUTRITION in g) {
            NutritionSyncWorker.schedulePeriodic(context)
            sources = runCatching { NutritionSync.recentSources(context) }.getOrNull()
        }
    }

    var refreshTick by remember { mutableIntStateOf(0) }

    val launcher = rememberLauncherForActivityResult(PermissionController.createRequestPermissionResultContract()) { result ->
        refreshTick++
        if (NutritionSync.READ_NUTRITION in result) {
            NutritionSyncWorker.schedulePeriodic(context)
            // First grant: backfill as far back as Health Connect allows.
            NutritionSyncWorker.runNow(context, NutritionSync.BACKFILL_DAYS_WITH_HISTORY)
        }
    }

    LaunchedEffect(refreshTick) { refresh() }
    // Pick up results of the background worker while this screen is open.
    LaunchedEffect(Unit) {
        while (true) {
            delay(2_000)
            lastSync = SyncStatus.load(context)
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val g = granted
        when {
            g == null -> Text("Checking permissions…", style = MaterialTheme.typography.bodySmall)
            NutritionSync.READ_NUTRITION !in g -> {
                Text(
                    "Turn on Health Connect in Lose It! (Profile → Automatic Tracking → Health Connect), then grant PaceSync read access here.",
                    style = MaterialTheme.typography.bodySmall,
                )
                Button(onClick = { launcher.launch(requestable) }, modifier = Modifier.fillMaxWidth()) {
                    Text("Grant Health Connect access")
                }
            }
            else -> {
                val missing = requestable - g
                val note = buildString {
                    append("Access granted. Checks Lose It! for changes every 15 minutes and sends only what changed.")
                    if (NutritionSync.READ_BACKGROUND in missing) append(" Background access not granted, so it only syncs while the app is open.")
                    if (NutritionSync.READ_HISTORY in missing) append(" History access not granted: only 30 days before the grant are readable.")
                }
                Text(note, style = MaterialTheme.typography.bodySmall)
                if (missing.isNotEmpty()) {
                    OutlinedButton(onClick = { launcher.launch(requestable) }, modifier = Modifier.fillMaxWidth()) {
                        Text("Grant remaining permissions")
                    }
                }
                Button(
                    onClick = { NutritionSyncWorker.runNow(context, NutritionSync.BACKFILL_DAYS_WITH_HISTORY) },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Sync now (full backfill)")
                }
                sources?.let { list ->
                    if (list.isEmpty()) {
                        Text(
                            "No nutrition records in Health Connect in the last 14 days. Check that Lose It! is writing to it.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.secondary,
                        )
                    } else {
                        Text("Nutrition written in the last 14 days:", style = MaterialTheme.typography.bodySmall)
                        list.forEach { s ->
                            val name = if (s.packageName == NutritionSync.LOSE_IT_PACKAGE) "Lose It!" else s.packageName
                            val note = if (s.packageName != NutritionSync.LOSE_IT_PACKAGE) " (not synced)" else ""
                            Text(
                                "• $name: ${s.records} entries, ${s.withMacros} with macros$note",
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                }
            }
        }
        lastSync?.let { (msg, at) ->
            val time = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(at))
            Text("Last sync ($time): $msg", style = MaterialTheme.typography.bodySmall)
        }
        SyncStatus.lastChecked(context)?.let { at ->
            Text(
                "Last checked: ${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(at))}",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary,
            )
        }
    }
}

private fun openHealthConnectInStore(context: Context) {
    val pkg = "com.google.android.apps.healthdata"
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$pkg&url=healthconnect%3A%2F%2Fonboarding"))
        .setPackage("com.android.vending")
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
        context.startActivity(intent)
    } catch (_: ActivityNotFoundException) {
        context.startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$pkg"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}
