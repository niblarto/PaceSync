package com.pacesync.app.network

import com.pacesync.app.network.dto.CoursesResponse
import com.pacesync.app.network.dto.FcmTokenRequest
import com.pacesync.app.network.dto.MobileTokenRequest
import com.pacesync.app.network.dto.MobileTokenResponse
import com.pacesync.app.network.dto.RouteResponse
import com.pacesync.app.network.dto.WorkoutsResponse
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

interface PaceSyncApi {
    // Schedule / Summary
    @GET("api/runna/workouts")
    suspend fun getWorkouts(@Query("force") force: Int? = null): Response<WorkoutsResponse>

    // Routes
    @GET("api/garmin/courses")
    suspend fun getCourses(): Response<CoursesResponse>

    @GET("api/garmin/route/{id}")
    suspend fun getActivityRoute(@Path("id") activityId: String): Response<RouteResponse>

    @GET("api/garmin/course-route/{courseId}")
    suspend fun getCourseRoute(@Path("courseId") courseId: String): Response<RouteResponse>

    // Auth / push registration — no bearer token needed for mint (session-
    // gated on the server instead), but the app never has a browser session,
    // so in practice this call only succeeds once a token already exists
    // from Settings' own web-side generation flow. Kept here for
    // completeness / a possible future in-app login flow.
    @POST("api/settings/mobile-token")
    suspend fun mintMobileToken(@Body body: MobileTokenRequest): Response<MobileTokenResponse>

    @POST("api/settings/fcm-token")
    suspend fun registerFcmToken(@Body body: FcmTokenRequest): Response<Unit>
}
