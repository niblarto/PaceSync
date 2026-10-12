package com.pacesync.app.network

import com.pacesync.app.BuildConfig
import com.pacesync.app.data.TokenStore
import com.pacesync.app.network.dto.MixBuildRequest
import com.pacesync.app.network.dto.RemixRequest
import com.pacesync.app.network.dto.ReplaceCandidatesBudgetRequest
import com.pacesync.app.network.dto.ReplaceCandidatesRequest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.BufferedReader
import java.util.concurrent.TimeUnit

// api/ai-dj/mix and api/ai-dj/remix both stream Server-Sent Events —
// Retrofit's suspend-fun-returning-a-parsed-Response pattern can't consume
// that directly, so this issues the POST via a plain OkHttp call instead and
// parses "data: {...}\n\n" lines manually, mirroring the web app's own
// reader loop (components/DashboardClient.tsx's buildMix()/
// aiRemixSelectedChartTracks(), same event shapes: "warning" | "progress" |
// "error" | "done").
//
// Uses its own long-read-timeout client rather than ApiClient's shared one —
// a mix build can run for minutes, and 15s is fine per-chunk (the server
// sends a ": hb" heartbeat comment every 15s precisely so a connection
// doesn't look dead between real events), but a generous margin avoids any
// edge case on a slow connection.
class MixBuildClient(tokenStore: TokenStore) {
    private val json = Json { ignoreUnknownKeys = true }

    private val client: OkHttpClient = OkHttpClient.Builder()
        .addInterceptor(AuthInterceptor(tokenStore))
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    /**
     * Issues the mix-build POST and invokes [onEvent] for each parsed SSE
     * event (`type` plus the raw JSON object, so callers can pull out
     * whichever fields that event type carries). Suspends until the stream
     * closes (a "done"/"error" event, a thrown exception, or the server
     * ending the response). Runs on Dispatchers.IO since this is blocking
     * stream reading, not a suspend-native OkHttp call.
     */
    suspend fun buildMix(request: MixBuildRequest, onEvent: (type: String, json: JsonElement) -> Unit) {
        postSse("api/ai-dj/mix", MixBuildRequest.serializer(), request, onEvent)
    }

    /**
     * Same SSE contract as [buildMix], for the multi-select "AI Remix" of
     * an already-built mix's selected tracks (api/ai-dj/remix).
     */
    suspend fun remix(request: RemixRequest, onEvent: (type: String, json: JsonElement) -> Unit) {
        postSse("api/ai-dj/remix", RemixRequest.serializer(), request, onEvent)
    }

    /**
     * Same SSE contract, for the single-track "Quick Swap" library search
     * (api/tracks/replace-candidates) — a library-only request (no
     * artistName/searchMode/forceOnline) returns near-instantly (one "done"
     * event, no "progress"), since that combination never triggers the
     * route's online top-up.
     */
    suspend fun replaceCandidates(request: ReplaceCandidatesRequest, onEvent: (type: String, json: JsonElement) -> Unit) {
        postSse("api/tracks/replace-candidates", ReplaceCandidatesRequest.serializer(), request, onEvent)
    }

    /**
     * Multi-select "quick swap" — fills one combined duration budget with
     * exact-BPM library tracks (api/tracks/replace-candidates-budget),
     * same SSE contract.
     */
    suspend fun replaceCandidatesBudget(request: ReplaceCandidatesBudgetRequest, onEvent: (type: String, json: JsonElement) -> Unit) {
        postSse("api/tracks/replace-candidates-budget", ReplaceCandidatesBudgetRequest.serializer(), request, onEvent)
    }

    private suspend fun <T> postSse(path: String, serializer: SerializationStrategy<T>, request: T, onEvent: (type: String, json: JsonElement) -> Unit) {
        withContext(Dispatchers.IO) {
            val bodyJson = json.encodeToString(serializer, request)
            val httpRequest = Request.Builder()
                .url("${BuildConfig.API_BASE_URL}$path")
                .post(bodyJson.toRequestBody("application/json".toMediaType()))
                .build()

            client.newCall(httpRequest).execute().use { response ->
                if (!response.isSuccessful) {
                    error("Request failed (${response.code})")
                }
                val source = response.body?.byteStream() ?: error("Empty response body")
                val reader = BufferedReader(source.reader(Charsets.UTF_8))
                val buffer = StringBuilder()

                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isEmpty()) {
                        // Blank line = end of one SSE event — flush the buffer.
                        val payload = buffer.toString()
                        buffer.clear()
                        if (payload.startsWith("data: ")) {
                            val jsonText = payload.removePrefix("data: ")
                            runCatching { json.parseToJsonElement(jsonText) }.getOrNull()?.let { element ->
                                val type = element.jsonObject["type"]?.jsonPrimitive?.content ?: return@let
                                onEvent(type, element)
                            }
                        }
                        // Lines starting ":" (heartbeat/padding comments) are
                        // silently ignored — they're not "data:" lines.
                    } else {
                        if (buffer.isNotEmpty()) buffer.append("\n")
                        buffer.append(line)
                    }
                }
            }
        }
    }
}
