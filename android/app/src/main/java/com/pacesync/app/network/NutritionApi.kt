package com.pacesync.app.network

import com.pacesync.app.BuildConfig
import com.pacesync.app.data.TokenStore
import com.pacesync.app.network.dto.NutritionDashboardDto
import com.pacesync.app.network.dto.NutritionSummaryStateDto
import com.pacesync.app.network.dto.WeightRefreshDto
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import retrofit2.Response
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Query
import java.util.concurrent.TimeUnit

// Nutrition page endpoints. Own client with a longer timeout than the main
// one (15s): the weight refresh waits on Garmin Connect.
interface NutritionApi {
    @GET("api/nutrition/dashboard")
    suspend fun getDashboard(@Query("days") days: Int): Response<NutritionDashboardDto>

    // Pull the latest weigh-ins from Garmin Connect.
    @POST("api/nutrition/weight-refresh")
    suspend fun refreshWeight(): Response<WeightRefreshDto>

    @GET("api/nutrition/summary")
    suspend fun getSummary(): Response<NutritionSummaryStateDto>

    // Writes today's AI summary if it's due and the AI is reachable.
    @POST("api/nutrition/summary")
    suspend fun ensureSummary(): Response<NutritionSummaryStateDto>

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        fun create(tokenStore: TokenStore): NutritionApi {
            val client = ApiClient.httpClient(tokenStore).newBuilder()
                .readTimeout(60, TimeUnit.SECONDS)
                .callTimeout(70, TimeUnit.SECONDS)
                .build()
            return Retrofit.Builder()
                .baseUrl(BuildConfig.API_BASE_URL)
                .client(client)
                .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
                .build()
                .create(NutritionApi::class.java)
        }
    }
}
