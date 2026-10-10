package com.pacesync.app.push

import android.Manifest
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.pacesync.app.MainActivity
import com.pacesync.app.R
import com.pacesync.app.data.TokenStore
import com.pacesync.app.network.ApiClient
import com.pacesync.app.network.dto.FcmTokenRequest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicInteger

// Receives every push the backend sends via lib/push.ts's sendPush() —
// covers all 11 notification event types (BBC updates, AI DJ, Strava sync
// errors, the ntfy test, and the daily digest), routed to the matching
// Notification Channel by the `type` data field.
class PaceSyncFirebaseMessagingService : FirebaseMessagingService() {

    private val scope = CoroutineScope(Dispatchers.IO)
    private val notificationId = AtomicInteger(1000)

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        // Register immediately — if no bearer token is saved yet (app not
        // logged in), this silently no-ops server-side (401), and MainActivity
        // re-registers once a token is saved (see Settings screen).
        val tokenStore = TokenStore(applicationContext)
        if (tokenStore.getToken() == null) return
        scope.launch {
            runCatching {
                ApiClient.create(tokenStore).registerFcmToken(FcmTokenRequest(fcmToken = token))
            }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        val title = message.notification?.title ?: message.data["title"] ?: "PaceSync"
        val body = message.notification?.body ?: message.data["body"] ?: return
        val type = message.data["type"]
        showNotification(applicationContext, title, body, type)
    }

    private fun showNotification(context: Context, title: String, body: String, type: String?) {
        val channelId = NotificationChannels.channelFor(type)
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
        }
        val pendingIntent = PendingIntent.getActivity(
            context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        if (ActivityCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) return // user hasn't granted the runtime permission (Android 13+) — nothing to post

        val manager = context.getSystemService(NotificationManager::class.java)
        manager.notify(notificationId.incrementAndGet(), notification)
    }
}
