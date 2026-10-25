package com.pacesync.app.network.dto

import kotlinx.serialization.Serializable

// Mirrors app/api/settings/nutrition (GET / POST) — the same Nutrition goals the
// web Settings page edits (lib/nutrition-config.ts). Weights are kg; weightUnit
// ("st", "lb" or "kg") only changes how they're shown.

@Serializable
data class NutritionSettingsDto(
    val targetWeightKg: Double? = null,
    val goalDate: String? = null,
    val dailyCalorieLimit: Double? = null,
    val minDailyCalories: Double = 1400.0,
    val weightUnit: String = "st",
    val trendDays: Int = 28,
    val kcalPerKg: Double = 7700.0,
    // Not part of the saved config: the 7-day average weight, today's date and the
    // fastest loss the goal date may need, used to work out the earliest goal date.
    val currentKg: Double? = null,
    val today: String? = null,
    val maxLossLbPerWeek: Double = 2.0,
)

// No defaults on purpose: the JSON encoder skips default-valued fields, and a
// cleared target / goal date / limit must be sent as an explicit null.
@Serializable
data class NutritionSettingsRequest(
    val targetWeightKg: Double?,
    val goalDate: String?,
    val dailyCalorieLimit: Double?,
    val minDailyCalories: Double,
    val weightUnit: String,
    val trendDays: Int,
    val kcalPerKg: Double,
)
