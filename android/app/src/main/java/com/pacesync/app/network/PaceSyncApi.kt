package com.pacesync.app.network

import com.pacesync.app.network.dto.CoursesResponse
import com.pacesync.app.network.dto.CronJobsResponse
import com.pacesync.app.network.dto.FcmTokenRequest
import com.pacesync.app.network.dto.MobileTokenRequest
import com.pacesync.app.network.dto.MobileTokenResponse
import com.pacesync.app.network.dto.PinnedRouteResponse
import com.pacesync.app.network.dto.RouteResponse
import com.pacesync.app.network.dto.TodaysRunHistoryResponse
import com.pacesync.app.network.dto.UpdateCronJobsRequest
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

    // Activity detail — pinned route (a pointer, not GPS data; follow up
    // with getActivityRoute if activityId is present) + tracklist.
    @GET("api/garmin/pin-route")
    suspend fun getPinnedRoute(@Query("date") date: String, @Query("title") title: String): Response<PinnedRouteResponse>

    @GET("api/todays-run/history")
    suspend fun getTodaysRunHistory(@Query("date") date: String, @Query("title") title: String): Response<TodaysRunHistoryResponse>

    // Auth / push registration — no bearer token needed for mint (session-
    // gated on the server instead), but the app never has a browser session,
    // so in practice this call only succeeds once a token already exists
    // from Settings' own web-side generation flow. Kept here for
    // completeness / a possible future in-app login flow.
    @POST("api/settings/mobile-token")
    suspend fun mintMobileToken(@Body body: MobileTokenRequest): Response<MobileTokenResponse>

    @POST("api/settings/fcm-token")
    suspend fun registerFcmToken(@Body body: FcmTokenRequest): Response<Unit>

    // Daily digest time/enabled state — shares the same job store the web
    // Settings cron table reads/writes (lib/cron-schedule.ts); only the
    // "digest" entry is ever sent from here (updateCronJobs applies each
    // entry independently, so a single-job array is enough).
    @GET("api/settings/cron")
    suspend fun getCronJobs(): Response<CronJobsResponse>

    @POST("api/settings/cron")
    suspend fun updateCronJobs(@Body body: UpdateCronJobsRequest): Response<CronJobsResponse>
}
