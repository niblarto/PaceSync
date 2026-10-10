package com.pacesync.app.data

import android.content.Context
import com.pacesync.app.network.ApiClient
import com.pacesync.app.network.PaceSyncApi

// Minimal manual DI — no Hilt needed at this scope (a handful of screens,
// one API client, one token store). Held on the Application so it survives
// configuration changes without being recreated per-Activity.
class AppContainer(context: Context) {
    val tokenStore: TokenStore = TokenStore(context.applicationContext)
    val api: PaceSyncApi by lazy { ApiClient.create(tokenStore) }
}
