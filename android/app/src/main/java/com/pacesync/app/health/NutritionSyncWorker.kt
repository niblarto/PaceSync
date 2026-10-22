package com.pacesync.app.health

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.pacesync.app.PaceSyncApplication
import java.io.IOException
import java.time.Instant
import java.util.concurrent.TimeUnit

// Periodically pushes the last week of Health Connect nutrition to the
// backend (re-sending recent days picks up meals logged late). Needs
// READ_HEALTH_DATA_IN_BACKGROUND to read while the app isn't in front.
class NutritionSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as PaceSyncApplication
        if (app.container.tokenStore.getToken() == null) return Result.success()
        if (!NutritionSync.isAvailable(applicationContext)) return Result.success()

        val days = inputData.getInt(KEY_DAYS, NutritionSync.PERIODIC_DAYS)
        return try {
            val r = NutritionSync.sync(applicationContext, app.container.api, days)
            SyncStatus.save(applicationContext, "Synced ${r.daysWithData} day(s), ${r.from} to ${r.to}")
            Result.success()
        } catch (e: SecurityException) {
            // Permission revoked, or background read not granted.
            SyncStatus.save(applicationContext, "Not allowed: ${e.message}")
            Result.success()
        } catch (e: IOException) {
            SyncStatus.save(applicationContext, "Network error: ${e.message}")
            Result.retry()
        } catch (e: Exception) {
            SyncStatus.save(applicationContext, "Failed: ${e.message}")
            Result.failure()
        }
    }

    companion object {
        private const val PERIODIC_NAME = "nutrition-sync"
        private const val ONE_OFF_NAME = "nutrition-sync-now"
        private const val KEY_DAYS = "days"

        private val networkConstraint = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        fun schedulePeriodic(context: Context) {
            val req = PeriodicWorkRequestBuilder<NutritionSyncWorker>(3, TimeUnit.HOURS)
                .setConstraints(networkConstraint)
                .build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(PERIODIC_NAME, ExistingPeriodicWorkPolicy.KEEP, req)
        }

        fun runNow(context: Context, days: Int) {
            val req = OneTimeWorkRequestBuilder<NutritionSyncWorker>()
                .setConstraints(networkConstraint)
                .setInputData(workDataOf(KEY_DAYS to days))
                .build()
            WorkManager.getInstance(context)
                .enqueueUniqueWork(ONE_OFF_NAME, ExistingWorkPolicy.REPLACE, req)
        }
    }
}

// Last sync outcome, shown in Settings. Not sensitive, so plain prefs.
object SyncStatus {
    private const val PREFS = "nutrition_sync"

    fun save(context: Context, message: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("message", message)
            .putLong("at", Instant.now().toEpochMilli())
            .apply()
    }

    fun load(context: Context): Pair<String, Long>? {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val msg = p.getString("message", null) ?: return null
        return msg to p.getLong("at", 0L)
    }
}
