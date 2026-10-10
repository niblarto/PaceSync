package com.pacesync.app.ui.settings

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.google.firebase.messaging.FirebaseMessaging
import com.pacesync.app.data.TokenStore
import com.pacesync.app.network.PaceSyncApi
import com.pacesync.app.network.dto.FcmTokenRequest
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

// Paste-the-token flow: the actual token is generated on the web Settings
// page (password+TOTP re-entry — see app/api/settings/mobile-token/route.ts),
// since the app itself has no browser session to mint one through the
// session-gated endpoint. This screen just stores whatever was pasted and,
// once stored, registers this device's FCM token so pushes start flowing.
@Composable
fun SettingsScreen(tokenStore: TokenStore, api: PaceSyncApi) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var tokenInput by remember { mutableStateOf(tokenStore.getToken() ?: "") }
    var status by remember { mutableStateOf<String?>(null) }

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
    }

    // Toast is a side effect — must run from an effect, not inline during
    // composition (which can re-run on every recomposition).
    LaunchedEffect(status) {
        status?.let { Toast.makeText(context, it, Toast.LENGTH_SHORT).show() }
    }
}
