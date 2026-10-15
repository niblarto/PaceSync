package com.pacesync.app.ui.common

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pacesync.app.network.PaceSyncApi
import com.pacesync.app.network.dto.PlaybackActionRequest
import com.pacesync.app.network.dto.PlaybackStateResponse
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private val ORANGE = Color(0xFFF97316)

// Spotify playback bar — what's playing, a seek slider and play/pause.
// Polls the server's /api/spotify/playback every few seconds and moves
// smoothly in between; with nothing playing it stays visible but idle
// ("-:--"). Bump refreshKey after starting a track to re-read straight away.
@Composable
fun PlaybackBar(api: PaceSyncApi, refreshKey: Any? = null, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf<PlaybackStateResponse?>(null) }
    var readAt by remember { mutableLongStateOf(0L) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var dragMs by remember { mutableStateOf<Float?>(null) }

    suspend fun refresh() {
        val r = runCatching { api.getPlaybackState() }.getOrNull()
        val body = r?.takeIf { it.isSuccessful }?.body()
        state = body?.takeIf { it.hasDevice && it.trackUri != null }
        readAt = System.currentTimeMillis()
    }

    LaunchedEffect(refreshKey) {
        if (refreshKey != null) delay(1200) // give Spotify a moment to switch
        while (true) {
            refresh()
            delay(4000)
        }
    }
    LaunchedEffect(state?.isPlaying) {
        while (state?.isPlaying == true) {
            now = System.currentTimeMillis()
            delay(250)
        }
    }

    val s = state
    val active = s != null && s.durationMs > 0
    val duration = s?.durationMs ?: 0L
    val live = when {
        !active -> 0L
        s!!.isPlaying -> (s.progressMs + (now - readAt)).coerceAtMost(duration)
        else -> s.progressMs
    }
    val pos = dragMs?.toLong() ?: live

    fun fmt(ms: Long) = "%d:%02d".format(ms / 60000, (ms / 1000) % 60)

    Column(modifier.fillMaxWidth()) {
        Text(
            if (active) listOfNotNull(s!!.trackName, s.artistName).joinToString(" — ").ifBlank { "Now playing" } else "Nothing playing",
            style = MaterialTheme.typography.labelMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            color = if (active) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(if (active) fmt(pos) else "-:--", fontFamily = FontFamily.Monospace, fontSize = 11.sp)
            Slider(
                value = if (active) pos.toFloat() else 0f,
                onValueChange = { if (active) dragMs = it },
                onValueChangeFinished = {
                    val target = dragMs?.toLong()
                    dragMs = null
                    if (target != null && s != null) {
                        state = s.copy(progressMs = target)
                        readAt = System.currentTimeMillis()
                        scope.launch {
                            runCatching { api.playbackAction(PlaybackActionRequest("seek", target)) }
                            delay(600); refresh()
                        }
                    }
                },
                valueRange = 0f..(if (active) duration.toFloat() else 1f),
                enabled = active,
                modifier = Modifier.weight(1f),
                colors = SliderDefaults.colors(thumbColor = ORANGE, activeTrackColor = ORANGE),
            )
            Text(if (active) fmt(duration) else "-:--", fontFamily = FontFamily.Monospace, fontSize = 11.sp)
            IconButton(
                onClick = {
                    val cur = state ?: return@IconButton
                    val resume = !cur.isPlaying
                    state = cur.copy(isPlaying = resume, progressMs = live)
                    readAt = System.currentTimeMillis()
                    scope.launch {
                        runCatching { api.playbackAction(PlaybackActionRequest(if (resume) "resume" else "pause")) }
                        delay(600); refresh()
                    }
                },
                enabled = active,
                modifier = Modifier.size(36.dp),
            ) {
                Icon(
                    if (active && s!!.isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                    contentDescription = if (active && s!!.isPlaying) "Pause" else "Play",
                    tint = if (active) ORANGE else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            androidx.compose.foundation.layout.Spacer(Modifier.width(0.dp))
        }
    }
}
