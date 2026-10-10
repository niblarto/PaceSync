package com.pacesync.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Dark-first palette matching the web app's own slate/green dashboard look
// (see components' "bg-slate-900/85" / "text-green-400" conventions).
private val DarkColors = darkColorScheme(
    primary = Color(0xFF34D399),      // emerald-400, matches web's accent
    secondary = Color(0xFF64748B),    // slate-500
    background = Color(0xFF0F172A),   // slate-900
    surface = Color(0xFF1E293B),      // slate-800
    error = Color(0xFFF87171),        // red-400
)

private val LightColors = lightColorScheme(
    primary = Color(0xFF059669),
    secondary = Color(0xFF64748B),
)

@Composable
fun PaceSyncTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colors = if (darkTheme) DarkColors else LightColors
    MaterialTheme(colorScheme = colors, content = content)
}
