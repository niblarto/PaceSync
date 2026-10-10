package com.pacesync.app.network.dto

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

// Mirrors lib/runna-schedule.ts's RunnaWorkout / RunnaPastRun exactly
// (see app/api/runna/workouts/route.ts). `type` is left as a raw String
// rather than a Kotlin enum — the backend's WorkoutType union can grow
// server-side without breaking deserialization here, callers switch on the
// known string values and fall back to a generic label for anything new.
@Serializable
data class RunnaWorkout(
    val uid: String,
    val date: String,          // YYYY-MM-DD
    val summary: String,
    val title: String,
    val type: String,
    val distanceMi: Double? = null,
    val durationSec: Int = 0,
    val segments: List<String> = emptyList(),
    val appUrl: String? = null,
    val suggestedZone: Int? = null,
)

@Serializable
data class RunnaPastRun(
    val uid: String,
    val date: String,
    val title: String,
    val type: String,
    val distanceMi: Double? = null,
    val durationStr: String? = null,
    val avgPace: String? = null,
    val laps: List<String> = emptyList(),
    val planSteps: List<String> = emptyList(),
    val appUrl: String? = null,
)

@Serializable
data class WorkoutsResponse(
    val workouts: List<RunnaWorkout> = emptyList(),
    val pastRuns: List<RunnaPastRun> = emptyList(),
)

@Serializable
data class GarminCourse(
    val id: Long,
    val name: String,
    val distanceMi: Double,
    val createdDate: Long,
)

@Serializable
data class CoursesResponse(val courses: List<GarminCourse> = emptyList())

// The backend emits each point as a plain JSON array —
//   [lat, lng, speedMph|null, elapsedSec|null, cumulativeMi]
// — a positional tuple, not an object, so this needs a custom serializer
// rather than a plain @Serializable data class (which only decodes JSON
// objects). See app/api/garmin/route/[id]/route.ts and
// app/api/garmin/course-route/[courseId]/route.ts for the source shape.
@Serializable(with = RoutePointSerializer::class)
data class RoutePoint(
    val lat: Double,
    val lng: Double,
    val speedMph: Double?,
    val elapsedSec: Double?,
    val cumulativeMi: Double,
)

object RoutePointSerializer : KSerializer<RoutePoint> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("RoutePoint", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): RoutePoint {
        val jsonDecoder = decoder as? JsonDecoder
            ?: error("RoutePointSerializer only supports JSON decoding")
        val arr: JsonArray = jsonDecoder.decodeJsonElement().jsonArray
        fun el(i: Int): JsonElement? = arr.getOrNull(i)
        fun double(i: Int): Double = (el(i) as? JsonPrimitive)?.doubleOrNull ?: 0.0
        fun doubleOrNull(i: Int): Double? {
            val e = el(i)
            return if (e == null || e is JsonNull) null else (e as? JsonPrimitive)?.doubleOrNull
        }
        return RoutePoint(
            lat = double(0),
            lng = double(1),
            speedMph = doubleOrNull(2),
            elapsedSec = doubleOrNull(3),
            cumulativeMi = double(4),
        )
    }

    // Not needed (the app never sends RoutePoints to the server), but
    // required to satisfy KSerializer.
    override fun serialize(encoder: Encoder, value: RoutePoint) {
        error("RoutePoint serialization is not supported — read-only DTO")
    }
}

@Serializable
data class RouteResponse(
    val name: String? = null,
    val distance: Double? = null,
    val points: List<RoutePoint> = emptyList(),
)

@Serializable
data class MobileTokenRequest(
    val username: String,
    val password: String,
    val totpCode: String? = null,
)

@Serializable
data class MobileTokenResponse(
    val token: String? = null,
    val totpRequired: Boolean? = null,
    val error: String? = null,
)

@Serializable
data class FcmTokenRequest(val fcmToken: String)

// Mirrors lib/pinned-routes.ts's PinnedRoute — a pointer (activityId) to a
// Garmin activity, not GPS data itself; the activity-detail screen follows
// up with getActivityRoute(activityId) when this is non-null (same two-step
// fetch the web app's own RunnaCard.tsx already does).
@Serializable
data class PinnedRoute(
    val date: String,
    val workoutTitle: String,
    val activityId: String,
    val name: String? = null,
    val distanceMi: Double? = null,
    val runDate: String? = null,
    val pinnedAt: String? = null,
    val paceProMixId: String? = null,
)

@Serializable
data class PinnedRouteResponse(val route: PinnedRoute? = null)

// Mirrors lib/todays-run-history.ts's HistoryTrack.
@Serializable
data class HistoryTrack(
    val uri: String? = null,
    val name: String,
    val artist: String,
    val startsAtSec: Double = 0.0,
    val durationSec: Double = 0.0,
    val targetPaceSec: Double? = null,
    val segment: String? = null,
    val tempo: Double? = null,
    val energy: Double? = null,
)

@Serializable
data class TodaysRunEntry(
    val date: String,
    val workoutTitle: String,
    val savedAt: String? = null,
    val tracks: List<HistoryTrack> = emptyList(),
    val pinned: Boolean? = null,
    val approved: Boolean? = null,
)

@Serializable
data class TodaysRunHistoryResponse(val entry: TodaysRunEntry? = null)

// Mirrors lib/cron-schedule.ts's CronJobState.
@Serializable
data class CronJobState(
    val key: String,
    val installed: Boolean,
    val enabled: Boolean,
    val time: String, // "HH:MM" 24h
    val day: Int? = null, // 0-6, Sunday=0; null = every day
)

@Serializable
data class CronJobsResponse(
    val available: Boolean = false,
    val jobs: List<CronJobState> = emptyList(),
)

@Serializable
data class CronJobUpdate(
    val key: String,
    val enabled: Boolean,
    val time: String,
    val day: Int? = null,
)

@Serializable
data class UpdateCronJobsRequest(val jobs: List<CronJobUpdate>)

// Mirrors app/api/garmin/similar-activities/route.ts's response — recent
// GarminDB activities at a matching distance, for the route picker.
@Serializable
data class SimilarActivity(
    val activity_id: String,
    val name: String? = null,
    val start_time: String,
    val distance: Double,
    val elapsed_time: String? = null,
    val avg_hr: Double? = null,
)

@Serializable
data class SimilarActivitiesResponse(
    val activities: List<SimilarActivity> = emptyList(),
    val total: Int = 0,
    val offset: Int = 0,
)

@Serializable
data class PinRouteRequest(
    val date: String,
    val workoutTitle: String,
    val activityId: String,
    val name: String? = null,
    val distanceMi: Double? = null,
    val runDate: String? = null,
)

@Serializable
data class UnpinRouteRequest(val date: String, val title: String)

// Request body for POST api/ai-dj/mix — mirrors RunnaCard.tsx's buildMix()
// call. Only the fields Android sends; the rest (avoidUris etc.) are
// optional server-side and simply omitted.
@Serializable
data class MixBuildRequest(
    val title: String,
    val segments: List<String>,
    val date: String? = null,
)

// Shape of the SSE "done" event's track/timeline data — mirrors
// lib/ai-dj-mix.ts's AiDjMixResponse["timeline"]. All numeric fields are
// Double, not Int: the server types them as plain TS `number`, which
// includes non-whole values (e.g. targetPaceSec/durationSec/totalSec can
// carry fractional seconds) — kotlinx.serialization throws decoding a JSON
// float into an Int field, which silently broke the whole "done" event
// (caught by a runCatching upstream, leaving the UI stuck on the last
// progress text forever). Round to Int only when displaying.
@Serializable
data class MixTrack(
    val uri: String,
    val name: String,
    val artist: String,
    val startsAt: String,
    val durationSec: Double = 0.0,
    val tempo: Double = 0.0,
    val camelot: String? = null,
    val energy: Double = 0.0,
)

@Serializable
data class MixTimelineSegment(
    val segment: String,
    val targetBpm: Double? = null,
    val targetPaceSec: Double? = null,
    val tracks: List<MixTrack> = emptyList(),
)

@Serializable
data class MixDoneEvent(
    val trackUris: List<String> = emptyList(),
    val totalSec: Double = 0.0,
    val timeline: List<MixTimelineSegment> = emptyList(),
)

@Serializable
data class PinMixRequest(
    val date: String,
    val workoutTitle: String,
    val totalSec: Double,
    val timeline: List<MixTimelineSegment>,
)

// Mirrors app/api/ai-dj/pin/route.ts's DELETE body — unpinning a mix also
// deletes the underlying "Today's Run" history entry server-side (not just
// the pin flag), so this is a genuine full remove, not a soft-unpin.
@Serializable
data class UnpinMixRequest(val date: String, val title: String)
