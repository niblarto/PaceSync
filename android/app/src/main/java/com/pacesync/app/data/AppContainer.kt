package com.pacesync.app.data

import android.content.Context
import com.pacesync.app.network.ApiClient
import com.pacesync.app.network.CoachApi
import com.pacesync.app.network.MixBuildClient
import com.pacesync.app.network.NutritionApi
import com.pacesync.app.network.PaceSyncApi

// Minimal manual DI — no Hilt needed at this scope (a handful of screens,
// one API client, one token store). Held on the Application so it survives
// configuration changes without being recreated per-Activity.
class AppContainer(context: Context) {
    val tokenStore: TokenStore = TokenStore(context.applicationContext)
    val api: PaceSyncApi by lazy { ApiClient.create(tokenStore) }
    val mixBuildClient: MixBuildClient by lazy { MixBuildClient(tokenStore) }
    val coachApi: CoachApi by lazy { CoachApi.create(tokenStore) }
    val nutritionApi: NutritionApi by lazy { NutritionApi.create(tokenStore) }
}
