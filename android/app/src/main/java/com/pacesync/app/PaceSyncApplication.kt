package com.pacesync.app

import android.app.Application
import com.pacesync.app.data.AppContainer
import com.pacesync.app.push.NotificationChannels

class PaceSyncApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        NotificationChannels.createAll(this)
    }
}
