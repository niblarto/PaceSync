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

// Mirrors app/api/ai-dj/remix/route.ts's body — a multi-select "AI Remix"
// request for a contiguous span of tracks (DashboardClient.tsx's
// aiRemixSelectedChartTracks): targetBpm is user-entered, budgetMs is the
// selected tracks' own combined duration (not the span between first/last
// selected index — a gap would otherwise inflate the budget), avoidUris is
// every track currently in the mix so the AI DJ never picks a duplicate.
@Serializable
data class RemixRequest(
    val targetBpm: Int,
    val budgetMs: Long,
    val avoidUris: List<String>,
)

// Shape of api/ai-dj/remix's SSE "done" event — same track/timeline shape
// as the full mix build (MixTrack/MixTimelineSegment), just one synthetic
// segment's worth of replacement tracks.
@Serializable
data class RemixDoneEvent(
    val trackUris: List<String> = emptyList(),
    val timeline: List<MixTimelineSegment> = emptyList(),
)

// Mirrors app/api/tracks/replace-candidates/route.ts's body — a library-
// only "Quick Swap" request (no artistName/searchMode/forceOnline sent,
// same subset DashboardClient.tsx's QuickSwapModal uses by default, which
// keeps the server-side online top-up from ever triggering).
@Serializable
data class ReplaceCandidatesRequest(
    val targetBpm: Int,
    val targetUri: String,
    val excludeUris: List<String>,
    val originalDurationMs: Long? = null,
)

// Mirrors app/api/tracks/replace-candidates/route.ts's ReplaceCandidate —
// only the fields the Android quick-swap list actually displays/uses are
// declared; the rest (key/mode/danceability/valence/genres) are omitted
// since ignoreUnknownKeys silently drops them.
@Serializable
data class ReplaceCandidate(
    val source: String,
    val uri: String? = null,
    val name: String,
    val artist: String,
    val tempo: Double,
    val effectiveBpm: Double,
    val durationMs: Long? = null,
)

@Serializable
data class ReplaceCandidatesDoneEvent(val candidates: List<ReplaceCandidate> = emptyList())

// Mirrors app/api/tracks/replace-candidates-budget/route.ts's body — the
// multi-select "quick swap" equivalent: fills one combined time budget
// with as many exact-BPM library tracks as fit closest, rather than
// swapping each selected slot 1-for-1 (same reasoning the web app's non-AI
// "Remix…" button uses). No artistNames/seedUris sent from Android — the
// server treats a missing/empty artistNames as "skip the online top-up",
// same library-only behavior as the single-track Quick Swap.
@Serializable
data class ReplaceCandidatesBudgetRequest(
    val targetBpm: Int,
    val budgetMs: Long,
    val excludeUris: List<String>,
)

@Serializable
data class ReplaceCandidatesBudgetDoneEvent(val tracks: List<ReplaceCandidate> = emptyList(), val warning: String? = null)

// Mirrors app/api/ai-dj/pin/route.ts's DELETE body — unpinning a mix also
// deletes the underlying "Today's Run" history entry server-side (not just
// the pin flag), so this is a genuine full remove, not a soft-unpin.
@Serializable
data class UnpinMixRequest(val date: String, val title: String)

// Mirrors app/api/spotify/create-playlist/route.ts — creates the named
// playlist or replaces an existing one's tracks.
@Serializable
data class CreatePlaylistRequest(val name: String, val description: String, val trackUris: List<String>)

@Serializable
data class CreatePlaylistResponse(val playlistId: String? = null, val url: String? = null, val tracksAdded: Boolean? = null, val error: String? = null)

// Mirrors app/api/todays-run/history/route.ts's POST body.
@Serializable
data class SaveTodaysRunRequest(val date: String, val workoutTitle: String, val timeline: List<MixTimelineSegment>)

// Mirrors app/api/spotify/play/route.ts's body — a spotify:track:<id> URI
// to start playing on the user's active Spotify device via the Web API.
@Serializable
data class PlayRequest(val uri: String? = null, val contextUri: String? = null)

// Mirrors app/api/spotify/playback/route.ts's body — "pause"/"resume" on
// whatever Spotify device is currently active, or "seek" (with positionMs)
// to jump to a specific offset in the currently playing track.
@Serializable
data class PlaybackActionRequest(val action: String, val positionMs: Long? = null)

// Mirrors app/api/spotify/playback/route.ts's GET response.
@Serializable
data class PlaybackStateResponse(
    val isPlaying: Boolean = false,
    val hasDevice: Boolean = false,
    val trackUri: String? = null,
    val trackName: String? = null,
    val artistName: String? = null,
    val progressMs: Long = 0,
    val durationMs: Long = 0,
)

// ── Song Crawler (app/api/tracks/song-crawler, lib/song-crawler.ts) ──

@Serializable
data class CrawlSources(val artist: Boolean, val radio: Boolean, val related: Boolean)

@Serializable
data class StartCrawlRequest(
    val artist: String,
    val link: String? = null,
    val bpm: Double? = null,
    val bpmMin: Double? = null,
    val bpmMax: Double? = null,
    val maxArtists: Int,
    val sources: CrawlSources,
)

@Serializable
data class StartCrawlResponse(val ok: Boolean = false, val id: String? = null, val error: String? = null)

@Serializable
data class CrawlLine(val seq: Int, val at: String, val level: String = "info", val msg: String)

@Serializable
data class CrawlAddedTrack(val uri: String, val name: String, val artist: String, val bpm: Int = 0)

@Serializable
data class CrawlParamsDto(
    val artist: String = "",
    val link: String? = null,
    val bpm: Double? = null,
    val bpmMin: Double? = null,
    val bpmMax: Double? = null,
)

@Serializable
data class CrawlJobDto(
    val id: String,
    val params: CrawlParamsDto = CrawlParamsDto(),
    val status: String,
    val startedAt: String,
    val added: Int = 0,
    val addedTracks: List<CrawlAddedTrack> = emptyList(),
    val crawled: Int = 0,
    val totalArtists: Int = 0,
    val checked: Int? = null,
    val linkName: String? = null,
)

@Serializable
data class CrawlStateResponse(val job: CrawlJobDto? = null, val lines: List<CrawlLine> = emptyList())

// reason "accepted" keeps the track; "deleted" + deleteFromLibrary has the
// server delete it from the library and Spotify playlist.
@Serializable
data class CrawlRemoveRequest(val removeAdded: String, val reason: String, val deleteFromLibrary: Boolean = false)
