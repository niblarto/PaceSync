package com.pacesync.app.health

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.NutritionRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.DataOrigin
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.pacesync.app.network.PaceSyncApi
import com.pacesync.app.network.dto.NutritionDayDto
import com.pacesync.app.network.dto.NutritionSyncRequest
import java.time.Instant
import java.time.LocalDate
import java.time.Period
import java.time.temporal.ChronoUnit

// Reads daily nutrition totals (written to Health Connect by Lose It!) and
// pushes them to the backend's /api/nutrition. Health Connect is on-device
// only, so the phone is the only place this data can be read from.
object NutritionSync {
    const val LOSE_IT_PACKAGE = "com.fitnow.loseit"

    // Without READ_HEALTH_DATA_HISTORY, Health Connect only returns data from
    // 30 days before the permission grant onwards.
    const val PERIODIC_DAYS = 7
    const val BACKFILL_DAYS_WITH_HISTORY = 180
    const val BACKFILL_DAYS_NO_HISTORY = 30

    val READ_NUTRITION = HealthPermission.getReadPermission(NutritionRecord::class)
    val READ_WEIGHT = HealthPermission.getReadPermission(WeightRecord::class)
    const val READ_BACKGROUND = HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND
    const val READ_HISTORY = HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY

    fun sdkStatus(context: Context): Int = HealthConnectClient.getSdkStatus(context)

    fun isAvailable(context: Context): Boolean = sdkStatus(context) == HealthConnectClient.SDK_AVAILABLE

    fun client(context: Context): HealthConnectClient = HealthConnectClient.getOrCreate(context)

    // Background/history permissions only exist on newer Health Connect
    // versions — requesting them where unsupported is pointless.
    fun permissionsToRequest(client: HealthConnectClient): Set<String> {
        val perms = mutableSetOf(READ_NUTRITION, READ_WEIGHT)
        val features = client.features
        if (features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND) ==
            HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
        ) perms += READ_BACKGROUND
        if (features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY) ==
            HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
        ) perms += READ_HISTORY
        return perms
    }

    data class SyncResult(val from: LocalDate, val to: LocalDate, val daysWithData: Int)

    // Reads [today - days + 1, today] and replaces that range on the server.
    suspend fun sync(context: Context, api: PaceSyncApi, days: Int): SyncResult {
        val hc = client(context)
        val granted = hc.permissionController.getGrantedPermissions()
        if (READ_NUTRITION !in granted) throw SecurityException("Health Connect nutrition permission not granted")

        val windowDays = if (READ_HISTORY in granted) days else minOf(days, BACKFILL_DAYS_NO_HISTORY)
        val today = LocalDate.now()
        val from = today.minusDays((windowDays - 1).toLong())
        val range = TimeRangeFilter.between(from.atStartOfDay(), today.plusDays(1).atStartOfDay())

        // Nutrition: Lose It! only, so another app writing meals can't double-count.
        val nutrition = hc.aggregateGroupByPeriod(
            AggregateGroupByPeriodRequest(
                metrics = setOf(
                    NutritionRecord.ENERGY_TOTAL,
                    NutritionRecord.PROTEIN_TOTAL,
                    NutritionRecord.TOTAL_CARBOHYDRATE_TOTAL,
                    NutritionRecord.TOTAL_FAT_TOTAL,
                ),
                timeRangeFilter = range,
                timeRangeSlicer = Period.ofDays(1),
                dataOriginFilter = setOf(DataOrigin(LOSE_IT_PACKAGE)),
            ),
        )

        // Weight: any source (Lose It!, a Garmin scale, ...), daily average.
        val weightByDay: Map<LocalDate, Double> = if (READ_WEIGHT in granted) {
            hc.aggregateGroupByPeriod(
                AggregateGroupByPeriodRequest(
                    metrics = setOf(WeightRecord.WEIGHT_AVG),
                    timeRangeFilter = range,
                    timeRangeSlicer = Period.ofDays(1),
                ),
            ).mapNotNull { g ->
                g.result[WeightRecord.WEIGHT_AVG]?.inKilograms?.let { g.startTime.toLocalDate() to it }
            }.toMap()
        } else emptyMap()

        val byDay = mutableMapOf<LocalDate, NutritionDayDto>()
        for (g in nutrition) {
            val date = g.startTime.toLocalDate()
            val energy = g.result[NutritionRecord.ENERGY_TOTAL]?.inKilocalories
            val protein = g.result[NutritionRecord.PROTEIN_TOTAL]?.inGrams
            val carbs = g.result[NutritionRecord.TOTAL_CARBOHYDRATE_TOTAL]?.inGrams
            val fat = g.result[NutritionRecord.TOTAL_FAT_TOTAL]?.inGrams
            if (energy == null && protein == null && carbs == null && fat == null) continue
            byDay[date] = NutritionDayDto(
                date = date.toString(),
                energyKcal = energy?.round1(),
                proteinG = protein?.round1(),
                carbsG = carbs?.round1(),
                fatG = fat?.round1(),
                source = LOSE_IT_PACKAGE,
            )
        }
        for ((date, kg) in weightByDay) {
            val existing = byDay[date] ?: NutritionDayDto(date = date.toString())
            byDay[date] = existing.copy(weightKg = kg.round2())
        }

        val body = NutritionSyncRequest(
            from = from.toString(),
            to = today.toString(),
            days = byDay.values.sortedBy { it.date },
        )
        val resp = api.syncNutrition(body)
        if (!resp.isSuccessful) throw java.io.IOException("Server returned ${resp.code()}")
        return SyncResult(from, today, body.days.size)
    }

    data class SourceSummary(val packageName: String, val records: Int, val withMacros: Int)

    // Which apps wrote nutrition records recently, and how many of those
    // carry macros (free Lose It! accounts may only sync calories).
    suspend fun recentSources(context: Context, days: Long = 14): List<SourceSummary> {
        val resp = client(context).readRecords(
            ReadRecordsRequest(
                recordType = NutritionRecord::class,
                timeRangeFilter = TimeRangeFilter.after(Instant.now().minus(days, ChronoUnit.DAYS)),
            ),
        )
        return resp.records.groupBy { it.metadata.dataOrigin.packageName }.map { (pkg, recs) ->
            SourceSummary(pkg, recs.size, recs.count { it.protein != null || it.totalCarbohydrate != null || it.totalFat != null })
        }.sortedByDescending { it.records }
    }

    private fun Double.round1() = Math.round(this * 10) / 10.0
    private fun Double.round2() = Math.round(this * 100) / 100.0
}
