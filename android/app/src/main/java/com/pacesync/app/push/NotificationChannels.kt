package com.pacesync.app.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build

// One channel per event category (mirrors lib/push.ts's `type` discriminator
// on the server) so the user can mute individual categories from Android's
// own per-app notification settings without needing an in-app toggle.
object NotificationChannels {
    const val BBC = "bbc"
    const val AI_DJ = "ai-dj"
    const val SYNC_ERROR = "sync-error"
    const val DIGEST = "digest"
    const val GENERAL = "general" // fallback for "test" and anything unmapped

    fun createAll(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        val channels = listOf(
            NotificationChannel(BBC, "BBC Playlist Updates", NotificationManager.IMPORTANCE_DEFAULT),
            NotificationChannel(AI_DJ, "AI DJ Mixes", NotificationManager.IMPORTANCE_DEFAULT),
            NotificationChannel(SYNC_ERROR, "Sync Errors", NotificationManager.IMPORTANCE_HIGH),
            NotificationChannel(DIGEST, "Daily Digest", NotificationManager.IMPORTANCE_DEFAULT),
            NotificationChannel(GENERAL, "General", NotificationManager.IMPORTANCE_DEFAULT),
        )
        channels.forEach(manager::createNotificationChannel)
    }

    /** Maps the server's `data.type` field to a channel id, defaulting to GENERAL. */
    fun channelFor(type: String?): String = when (type) {
        BBC, AI_DJ, SYNC_ERROR, DIGEST -> type
        else -> GENERAL
    }
}
