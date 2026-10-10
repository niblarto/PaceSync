package com.pacesync.app.network

import com.pacesync.app.BuildConfig
import com.pacesync.app.data.TokenStore
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.util.concurrent.TimeUnit

object ApiClient {
    private val json = Json { ignoreUnknownKeys = true }

    @Volatile private var retrofit: Retrofit? = null

    // Shared with MixBuildClient so the SSE mix-build request goes out with
    // the same AuthInterceptor-attached bearer token — built once, same as
    // Retrofit's own client.
    @Volatile private var sharedHttpClient: OkHttpClient? = null

    fun create(tokenStore: TokenStore): PaceSyncApi {
        val existing = retrofit
        val r = existing ?: buildRetrofit(tokenStore).also { retrofit = it }
        return r.create(PaceSyncApi::class.java)
    }

    fun httpClient(tokenStore: TokenStore): OkHttpClient {
        val existing = sharedHttpClient
        return existing ?: buildHttpClient(tokenStore).also { sharedHttpClient = it }
    }

    private fun buildHttpClient(tokenStore: TokenStore): OkHttpClient {
        val logging = HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) HttpLoggingInterceptor.Level.BASIC else HttpLoggingInterceptor.Level.NONE
        }
        return OkHttpClient.Builder()
            .addInterceptor(AuthInterceptor(tokenStore))
            .addInterceptor(logging)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .build()
    }

    private fun buildRetrofit(tokenStore: TokenStore): Retrofit {
        return Retrofit.Builder()
            .baseUrl(BuildConfig.API_BASE_URL)
            .client(httpClient(tokenStore))
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
    }
}
