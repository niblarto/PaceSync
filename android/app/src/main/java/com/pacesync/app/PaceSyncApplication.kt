package com.pacesync.app

import android.app.Application
import com.pacesync.app.data.AppContainer
import androidx.work.WorkManager
import com.pacesync.app.push.NotificationChannels

class PaceSyncApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        NotificationChannels.createAll(this)
        // Food used to be pushed from Health Connect every 15 minutes; the
        // server now syncs Lose It! itself. WorkManager keeps scheduled work
        // across app updates, so cancel the old job on phones that have it.
        WorkManager.getInstance(this).apply {
            cancelUniqueWork("nutrition-sync")
            cancelUniqueWork("nutrition-sync-now")
        }
    }
}
