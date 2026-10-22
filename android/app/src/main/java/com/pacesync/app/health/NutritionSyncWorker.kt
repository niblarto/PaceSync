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

// Every 15 minutes (Android's minimum for background work) checks Health
// Connect's changes feed and sends the backend only the days whose food
// changed. "Sync now" runs a full backfill instead. Needs
// READ_HEALTH_DATA_IN_BACKGROUND to read while the app isn't in front.
class NutritionSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as PaceSyncApplication
        if (app.container.tokenStore.getToken() == null) return Result.success()
        if (!NutritionSync.isAvailable(applicationContext)) return Result.success()

        val days = inputData.getInt(KEY_DAYS, 0)
        return try {
            val r = if (days > 0) NutritionSync.sync(applicationContext, app.container.api, days)
            else NutritionSync.syncIfChanged(applicationContext, app.container.api)
            if (r != null) SyncStatus.save(applicationContext, "Synced ${r.daysWithData} day(s), ${r.from} to ${r.to}")
            SyncStatus.checked(applicationContext)
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
            val req = PeriodicWorkRequestBuilder<NutritionSyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(networkConstraint)
                .build()
            // UPDATE (not KEEP) so an existing 3-hourly schedule switches to 15 min.
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(PERIODIC_NAME, ExistingPeriodicWorkPolicy.UPDATE, req)
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

    // When the changes feed was last checked (even if nothing had changed).
    fun checked(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong("checked_at", Instant.now().toEpochMilli()).apply()
    }

    fun lastChecked(context: Context): Long? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong("checked_at", 0L).takeIf { it > 0 }

    fun load(context: Context): Pair<String, Long>? {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val msg = p.getString("message", null) ?: return null
        return msg to p.getLong("at", 0L)
    }
}
