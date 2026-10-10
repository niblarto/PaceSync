package com.pacesync.app.network

import com.pacesync.app.data.TokenStore
import okhttp3.Interceptor
import okhttp3.Response

// Adds `Authorization: Bearer <token>` to every outgoing request, mirroring
// the server's lib/mobile-auth.ts hasApiAccess() check. The mobile-token
// mint endpoint itself (requires its own session+password, not a bearer
// token) doesn't need this header, but attaching it unconditionally is
// harmless — that endpoint simply ignores it.
class AuthInterceptor(private val tokenStore: TokenStore) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val token = tokenStore.getToken()
        val request = if (token != null) {
            chain.request().newBuilder()
                .addHeader("Authorization", "Bearer $token")
                .build()
        } else {
            chain.request()
        }
        return chain.proceed(request)
    }
}
