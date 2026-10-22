package com.pacesync.app

import android.app.Application
import com.pacesync.app.data.AppContainer
import com.pacesync.app.health.NutritionSync
import com.pacesync.app.health.NutritionSyncWorker
import com.pacesync.app.push.NotificationChannels

class PaceSyncApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        NotificationChannels.createAll(this)
        // 15-minute Health Connect changes check (the worker itself exits
        // quietly if permission isn't granted yet).
        if (NutritionSync.isAvailable(this)) NutritionSyncWorker.schedulePeriodic(this)
    }
}
