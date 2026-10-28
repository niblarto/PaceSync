package com.pacesync.app.network.dto

import kotlinx.serialization.Serializable

// Mirrors the server's Lose It! food diary (lib/loseit-food.ts):
// GET api/loseit/diary, POST api/loseit/sync, and api/settings/loseit.

@Serializable
data class LoseItTotalsDto(
    val kcal: Double = 0.0,
    val proteinG: Double = 0.0,
    val carbsG: Double = 0.0,
    val fatG: Double = 0.0,
)

@Serializable
data class LoseItFoodDto(
    val name: String,
    val brand: String? = null,
    val quantity: Double? = null,
    val units: String? = null,
    val kcal: Double? = null,
    val proteinG: Double? = null,
    val carbsG: Double? = null,
    val fatG: Double? = null,
)

@Serializable
data class LoseItMealDto(
    val meal: Int,
    val name: String,
    val foods: List<LoseItFoodDto> = emptyList(),
    val totals: LoseItTotalsDto = LoseItTotalsDto(),
)

@Serializable
data class LoseItSyncResultDto(
    val status: String,
    val error: String? = null,
)

@Serializable
data class LoseItDiaryDto(
    val date: String,
    val meals: List<LoseItMealDto> = emptyList(),
    val totals: LoseItTotalsDto = LoseItTotalsDto(),
    val connected: Boolean = false,
    val lastSyncAt: String? = null,
    val lastError: String? = null,
    val sync: LoseItSyncResultDto? = null,
)

@Serializable
data class LoseItStatusDto(
    val connected: Boolean = false,
    val email: String? = null,
    val sessionExpiresAt: String? = null,
    val importedAt: String? = null,
    val importedRows: Int = 0,
    val lastDaySyncAt: String? = null,
    val lastError: String? = null,
    val lastErrorAt: String? = null,
    val foods: Int = 0,
    val firstDate: String? = null,
    val lastDate: String? = null,
    val sync: LoseItSyncResultDto? = null,
)

@Serializable
data class LoseItConnectRequest(val email: String, val password: String)

// No default on purpose: the JSON encoder skips default-valued fields.
@Serializable
data class LoseItSyncRequest(val full: Boolean)
