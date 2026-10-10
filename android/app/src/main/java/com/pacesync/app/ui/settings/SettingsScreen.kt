package com.pacesync.app.ui.settings

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.google.firebase.messaging.FirebaseMessaging
import com.pacesync.app.data.TokenStore
import com.pacesync.app.network.PaceSyncApi
import com.pacesync.app.network.dto.CronJobUpdate
import com.pacesync.app.network.dto.FcmTokenRequest
import com.pacesync.app.network.dto.UpdateCronJobsRequest
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

// Paste-the-token flow: the actual token is generated on the web Settings
// page (password+TOTP re-entry — see app/api/settings/mobile-token/route.ts),
// since the app itself has no browser session to mint one through the
// session-gated endpoint. This screen just stores whatever was pasted and,
// once stored, registers this device's FCM token so pushes start flowing.
//
// Also surfaces the daily-digest time/enabled toggle — the same job store
// the web Settings cron table reads/writes (lib/cron-schedule.ts), so a
// change made here round-trips there and vice versa.
@Composable
fun SettingsScreen(tokenStore: TokenStore, api: PaceSyncApi) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var tokenInput by remember { mutableStateOf(tokenStore.getToken() ?: "") }
    var status by remember { mutableStateOf<String?>(null) }

    var digestEnabled by remember { mutableStateOf(false) }
    var digestHour by remember { mutableStateOf("06") }
    var digestMinute by remember { mutableStateOf("30") }
    var digestInstalled by remember { mutableStateOf(false) }
    var digestStatus by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        runCatching { api.getCronJobs() }.getOrNull()?.let { resp ->
            if (resp.isSuccessful) {
                val digest = resp.body()?.jobs?.find { it.key == "digest" }
                if (digest != null) {
                    digestInstalled = digest.installed
                    digestEnabled = digest.enabled
                    val parts = digest.time.split(":")
                    if (parts.size == 2) {
                        digestHour = parts[0]
                        digestMinute = parts[1]
                    }
                }
            }
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Paste the mobile token generated from the PaceSync Settings page (Notifications tab → Mobile App).", style = MaterialTheme.typography.bodyMedium)
        OutlinedTextField(
            value = tokenInput,
            onValueChange = { tokenInput = it },
            label = { Text("API token") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = false,
            maxLines = 4,
        )
        Button(
            onClick = {
                tokenStore.saveToken(tokenInput.trim())
                status = "Token saved."
                scope.launch {
                    runCatching {
                        val fcmToken = FirebaseMessaging.getInstance().token.await()
                        api.registerFcmToken(FcmTokenRequest(fcmToken = fcmToken))
                    }.onSuccess {
                        status = "Token saved — push notifications registered."
                    }.onFailure {
                        status = "Token saved, but push registration failed: ${it.message}"
                    }
                }
            },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Save token & register for push")
        }
        status?.let { Text(it, style = MaterialTheme.typography.bodySmall) }

        HorizontalDivider(Modifier.padding(vertical = 8.dp))

        Text("Daily digest", style = MaterialTheme.typography.titleMedium)
        if (!digestInstalled) {
            Text(
                "Not set up on the server yet — deploy the backend first.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.secondary,
            )
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Switch(checked = digestEnabled, onCheckedChange = { digestEnabled = it })
                Text("Enabled", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(start = 8.dp))
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = digestHour,
                    onValueChange = { if (it.length <= 2) digestHour = it.filter(Char::isDigit) },
                    label = { Text("HH") },
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.width(80.dp),
                )
                Text(":", style = MaterialTheme.typography.headlineSmall)
                OutlinedTextField(
                    value = digestMinute,
                    onValueChange = { if (it.length <= 2) digestMinute = it.filter(Char::isDigit) },
                    label = { Text("MM") },
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.width(80.dp),
                )
            }
            Button(
                onClick = {
                    val hh = digestHour.toIntOrNull()?.coerceIn(0, 23) ?: 6
                    val mm = digestMinute.toIntOrNull()?.coerceIn(0, 59) ?: 30
                    val time = "%02d:%02d".format(hh, mm)
                    scope.launch {
                        runCatching {
                            api.updateCronJobs(
                                UpdateCronJobsRequest(
                                    jobs = listOf(CronJobUpdate(key = "digest", enabled = digestEnabled, time = time, day = null)),
                                ),
                            )
                        }.onSuccess { resp ->
                            digestStatus = if (resp.isSuccessful) "Saved." else "Save failed (${resp.code()})"
                        }.onFailure {
                            digestStatus = "Save failed: ${it.message}"
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Save digest time")
            }
            digestStatus?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        }
    }

    // Toast is a side effect — must run from an effect, not inline during
    // composition (which can re-run on every recomposition).
    LaunchedEffect(status) {
        status?.let { Toast.makeText(context, it, Toast.LENGTH_SHORT).show() }
    }
}
