package com.pacesync.app.network

import com.pacesync.app.BuildConfig
import com.pacesync.app.data.TokenStore
import com.pacesync.app.network.dto.CoachChatResponse
import com.pacesync.app.network.dto.CoachMemoryResponse
import com.pacesync.app.network.dto.CoachReportsResponse
import com.pacesync.app.network.dto.CoachSendRequest
import com.pacesync.app.network.dto.CoachSendResponse
import com.pacesync.app.network.dto.RunFeedbackRequest
import com.pacesync.app.network.dto.RunFeedbackResponse
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import retrofit2.Response
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Query
import java.util.concurrent.TimeUnit

// Coach + post-run feedback endpoints. Own Retrofit instance: a coach reply
// on the local model can take a minute, well past the main client's 15s
// read timeout.
interface CoachApi {
    @GET("api/coach/chat")
    suspend fun getChat(): Response<CoachChatResponse>

    @POST("api/coach/chat")
    suspend fun send(@Body body: CoachSendRequest): Response<CoachSendResponse>

    // "New conversation" — the old one is summarised into memory.
    @DELETE("api/coach/session")
    suspend fun newConversation(): Response<Unit>

    @GET("api/coach/memory")
    suspend fun getMemories(): Response<CoachMemoryResponse>

    @DELETE("api/coach/memory")
    suspend fun forgetMemory(@Query("id") id: String): Response<Unit>

    @GET("api/coach/reports")
    suspend fun getReports(): Response<CoachReportsResponse>

    // Starts writing this week's report in the background; poll getReports.
    @POST("api/coach/reports")
    suspend fun writeReport(): Response<Unit>

    @GET("api/run-feedback")
    suspend fun getRunFeedback(@Query("date") date: String, @Query("title") title: String): Response<RunFeedbackResponse>

    @POST("api/run-feedback")
    suspend fun saveRunFeedback(@Body body: RunFeedbackRequest): Response<RunFeedbackResponse>

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        fun create(tokenStore: TokenStore): CoachApi {
            val client = ApiClient.httpClient(tokenStore).newBuilder()
                .readTimeout(330, TimeUnit.SECONDS)
                .callTimeout(340, TimeUnit.SECONDS)
                .build()
            return Retrofit.Builder()
                .baseUrl(BuildConfig.API_BASE_URL)
                .client(client)
                .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
                .build()
                .create(CoachApi::class.java)
        }

        // Server error bodies are {"error": "..."}.
        fun errorText(resp: Response<*>): String {
            val raw = runCatching { resp.errorBody()?.string() }.getOrNull().orEmpty()
            val msg = Regex("\"error\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").find(raw)?.groupValues?.get(1)
            return msg?.replace("\\\"", "\"") ?: "Error ${resp.code()}"
        }
    }
}
