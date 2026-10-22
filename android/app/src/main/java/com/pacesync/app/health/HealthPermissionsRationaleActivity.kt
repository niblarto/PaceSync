package com.pacesync.app.health

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.pacesync.app.ui.theme.PaceSyncTheme

// Required by Health Connect: shown from the permission dialog's "privacy
// policy" link (Android 13-) and from the system's app-permission screen
// (Android 14+, via the ViewPermissionUsageActivity alias in the manifest).
class HealthPermissionsRationaleActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            PaceSyncTheme {
                Surface(Modifier.fillMaxSize()) {
                    Column(
                        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text("How PaceSync uses your health data", style = MaterialTheme.typography.headlineSmall)
                        Text(
                            "PaceSync reads nutrition (calories, protein, carbohydrate, fat) and body weight " +
                                "from Health Connect. These are usually written there by Lose It!.",
                        )
                        Text(
                            "Once a day's records are read, PaceSync adds them up into daily totals and sends only " +
                                "those totals to your own PaceSync server. Your running coach uses them next to " +
                                "your Garmin data. Individual meals and foods are not sent.",
                        )
                        Text(
                            "Background access lets this sync run every few hours without opening the app. " +
                                "History access lets the first sync read further back than 30 days.",
                        )
                        Text(
                            "Nothing is shared with third parties. You can revoke access at any time in " +
                                "Health Connect, and PaceSync will stop reading.",
                        )
                        Button(onClick = { finish() }) { Text("Close") }
                    }
                }
            }
        }
    }
}
