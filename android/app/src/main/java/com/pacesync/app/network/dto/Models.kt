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
