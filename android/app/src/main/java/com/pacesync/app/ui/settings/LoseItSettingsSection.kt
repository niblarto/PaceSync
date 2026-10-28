package com.pacesync.app.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.pacesync.app.network.NutritionApi
import com.pacesync.app.network.dto.LoseItConnectRequest
import com.pacesync.app.network.dto.LoseItStatusDto
import com.pacesync.app.network.dto.LoseItSyncRequest
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import retrofit2.Response
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

// Settings → Lose It! food diary: the same as the web Settings → Nutrition card.
// The server keeps the login (api/settings/loseit) and reads the diary itself,
// so this works without the Lose It! app being on this phone.
@Composable
fun LoseItSettingsSection(nutritionApi: NutritionApi) {
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf<LoseItStatusDto?>(null) }
    var failed by remember { mutableStateOf(false) }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var editing by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf<String?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    var isError by remember { mutableStateOf(false) }
    var confirmDisconnect by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        val resp = runCatching { nutritionApi.getLoseItStatus() }.getOrNull()
        val body = resp?.takeIf { it.isSuccessful }?.body()
        if (body != null) status = body else failed = true
    }

    fun errorOf(resp: Response<LoseItStatusDto>): String =
        resp.errorBody()?.string()?.let {
            runCatching {
                val o = Json.parseToJsonElement(it).jsonObject
                o["error"]?.jsonPrimitive?.content ?: o["sync"]?.jsonObject?.get("error")?.jsonPrimitive?.content
            }.getOrNull()
        } ?: "Failed (${resp.code()})"

    fun act(label: String, call: suspend () -> Response<LoseItStatusDto>, done: (LoseItStatusDto) -> String) {
        busy = label; message = null
        scope.launch {
            val resp = runCatching { call() }.getOrNull()
            when {
                resp == null -> { message = "Couldn't reach the server"; isError = true }
                resp.isSuccessful && resp.body() != null -> { status = resp.body(); message = done(resp.body()!!); isError = false }
                else -> { message = errorOf(resp); isError = true }
            }
            busy = null
        }
    }

    Text("Lose It! food diary", style = MaterialTheme.typography.titleMedium)
    Text(
        "Lets the Nutrition tab show each day's foods. PaceSync's server logs in to Lose It! and downloads your " +
            "history once; after that it only re-reads today (a few KB, hourly and when you open Nutrition), plus yesterday once a day.",
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary,
    )

    val st = status
    if (st == null) {
        Text(if (failed) "Couldn't load the Lose It! status — is the token set and the server reachable?" else "Loading…", style = MaterialTheme.typography.bodySmall)
        return
    }

    if (st.connected) {
        val stamp = { iso: String? ->
            iso?.let { runCatching { OffsetDateTime.parse(it).atZoneSameInstant(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("d MMM, HH:mm")) }.getOrNull() } ?: "never"
        }
        val day = { d: String? -> d?.let { runCatching { LocalDate.parse(it).format(DateTimeFormatter.ofPattern("d MMM yyyy")) }.getOrNull() } ?: "—" }
        Text("Account: ${st.email}", style = MaterialTheme.typography.bodySmall)
        Text("Last sync: ${stamp(st.lastDaySyncAt)}", style = MaterialTheme.typography.bodySmall)
        Text("Stored: ${"%,d".format(st.foods)} foods, ${day(st.firstDate)} – ${day(st.lastDate)}", style = MaterialTheme.typography.bodySmall)
        st.lastError?.let { Text("Last error (${stamp(st.lastErrorAt)}): $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
    }

    if (!st.connected || editing) {
        OutlinedTextField(
            email, { email = it.trim(); message = null }, label = { Text("Lose It! email") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            password, { password = it; message = null }, label = { Text("Password") }, singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth(),
        )
        Text(
            "The password is stored on the PaceSync server so it can log back in when the 14-day Lose It! session runs out. " +
                "Google or Apple sign-in won't work; set a password on your Lose It! account first.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = {
                    act("connect", { nutritionApi.connectLoseIt(LoseItConnectRequest(email, password)) }) { s ->
                        password = ""; editing = false
                        if (s.sync?.status == "error") "Connected, but the first sync failed: ${s.sync.error}" else "Connected. ${"%,d".format(s.foods)} foods imported."
                    }
                },
                enabled = busy == null && email.isNotBlank() && password.isNotEmpty(),
            ) { Text(if (busy == "connect") "Connecting…" else "Connect") }
            if (editing) TextButton(onClick = { editing = false }, enabled = busy == null) { Text("Cancel") }
        }
    } else {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { act("sync", { nutritionApi.syncLoseIt(LoseItSyncRequest(full = false)) }) { "Synced today." } }, enabled = busy == null) {
                Text(if (busy == "sync") "Syncing…" else "Sync today")
            }
            OutlinedButton(onClick = { act("full", { nutritionApi.syncLoseIt(LoseItSyncRequest(full = true)) }) { s -> "History rebuilt: ${"%,d".format(s.foods)} foods." } }, enabled = busy == null) {
                Text(if (busy == "full") "Rebuilding…" else "Full resync")
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { editing = true; email = st.email ?: "" }, enabled = busy == null) { Text("Change login") }
            TextButton(onClick = { confirmDisconnect = true }, enabled = busy == null) { Text("Disconnect", color = MaterialTheme.colorScheme.error) }
        }
        Text(
            "Full resync re-downloads the whole Lose It! export (~1.6 MB) to pick up edits to older days.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary,
        )
    }

    message?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.secondary) }

    if (confirmDisconnect) {
        AlertDialog(
            onDismissRequest = { confirmDisconnect = false },
            title = { Text("Disconnect Lose It!?") },
            text = { Text("The server forgets the Lose It! login. The food diary already stored is kept.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDisconnect = false
                    act("disconnect", { nutritionApi.disconnectLoseIt() }) { "Disconnected." }
                }) { Text("Disconnect") }
            },
            dismissButton = { TextButton(onClick = { confirmDisconnect = false }) { Text("Cancel") } },
        )
    }
}
