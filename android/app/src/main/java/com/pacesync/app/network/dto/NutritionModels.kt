package com.pacesync.app.network.dto

import kotlinx.serialization.Serializable

// Mirrors app/api/nutrition/route.ts. The server replaces every row in
// [from, to] with `days`, so days with no data are simply left out.
@Serializable
data class NutritionDayDto(
    val date: String, // YYYY-MM-DD, local day
    val energyKcal: Double? = null,
    val proteinG: Double? = null,
    val carbsG: Double? = null,
    val fatG: Double? = null,
    val weightKg: Double? = null,
    val source: String? = null,
)

@Serializable
data class NutritionSyncRequest(
    val from: String,
    val to: String,
    val days: List<NutritionDayDto>,
)

@Serializable
data class NutritionSyncResponse(
    val ok: Boolean = false,
    val saved: Int = 0,
)
