package com.pacesync.app.network.dto

import kotlinx.serialization.Serializable

// Mirrors lib/nutrition-dashboard.ts (GET api/nutrition/dashboard) and
// lib/nutrition-summary.ts (api/nutrition/summary).

@Serializable
data class NutritionConfigDto(
    val targetWeightKg: Double? = null,
    val goalDate: String? = null,
    val dailyCalorieLimit: Double? = null,
    val minDailyCalories: Double = 1400.0, // eating less than this in a day shows red
    val weightUnit: String = "st",
    val trendDays: Int = 28,
    val kcalPerKg: Double = 7700.0,
)

// Inputs of the day's protein/carb/fat targets (lib/macro-targets.ts).
@Serializable
data class MacroPlanDto(val proteinG: Double? = null, val fatPct: Double = 25.0, val limitKcal: Double? = null)

@Serializable
data class NutritionDayRow(
    val date: String,
    val eaten: Double? = null,
    val proteinG: Double? = null,
    val carbsG: Double? = null,
    val fatG: Double? = null,
    val burnt: Double? = null,
    val resting: Double? = null,
    val exercise: Double? = null,
    val weightKg: Double? = null,
    val deficit: Double? = null,
    val net: Double? = null, // eaten − burnt; negative = deficit
    val partial: Boolean = false, // today: burnt/net are "so far"
)

@Serializable
data class WeightPoint(val date: String, val kg: Double)

@Serializable
data class CurrentWeightDto(
    val kg: Double,
    val date: String,
    val avg7Kg: Double,
    val measuredAt: String? = null,
    val source: String? = null,
    val postRun: Boolean = false, // the latest reading is a post-run one
    val regularKg: Double? = null, // the latest regular (pre-breakfast) weight
)

@Serializable
data class NutritionAveragesDto(
    val eaten: Double? = null,
    val burnt: Double? = null,
    val exercise: Double? = null,
    val deficit: Double? = null,
    val net: Double? = null,
    val loggedDays: Int = 0,
    val windowDays: Int = 0,
    val deficit7: Double? = null,
    val deficit7Days: Int = 0,
)

@Serializable
data class ProjectionDto(
    val method: String, // trend | trend7 | energy | plan | postrun
    val label: String,
    val basis: String,
    val kgPerWeek: Double,
    val weightAtGoalKg: Double? = null,
    val hitDate: String? = null,
    val hitStatus: String, // reached | on-course | never
    val rawKgPerWeek: Double = 0.0,
    val capped: Boolean = false,
    val anchorKg: Double? = null, // where this projection starts today (the post-run line starts lower than the 7-day average)
)

@Serializable
data class RequiredDto(val kgPerWeek: Double, val dailyBalance: Double, val intake: Double? = null)

@Serializable
data class NutritionDashboardDto(
    val config: NutritionConfigDto = NutritionConfigDto(),
    val today: String,
    val days: List<NutritionDayRow> = emptyList(),
    val weights: List<WeightPoint> = emptyList(),
    val postRunWeights: List<WeightPoint> = emptyList(), // weigh-ins taken within 3 hours after a run
    val current: CurrentWeightDto? = null,
    val averages: NutritionAveragesDto = NutritionAveragesDto(),
    val projections: List<ProjectionDto> = emptyList(),
    val required: RequiredDto? = null,
    val trendFit: TrendFitDto? = null,
    val trendFit7: TrendFitDto? = null,
    val postRunFit: TrendFitDto? = null,
    val macroPlan: MacroPlanDto? = null,
)

@Serializable
data class TrendFitDto(val startDate: String, val startKg: Double, val endDate: String, val endKg: Double)

@Serializable
data class NutritionSummaryDto(
    val id: Int,
    val createdAt: String,
    val periodStart: String,
    val periodEnd: String,
    val content: String,
    val model: String? = null,
)

@Serializable
data class SummaryResultDto(val status: String, val reason: String? = null)

@Serializable
data class NutritionSummaryStateDto(
    val summary: NutritionSummaryDto? = null,
    val due: Boolean = false,
    val nextAt: String? = null,
    val writing: Boolean = false,
    val error: String? = null,
    val result: SummaryResultDto? = null,
)

@Serializable
data class WeightRefreshDto(val ok: Boolean = false, val days: Int = 0, val latest: WeightPoint? = null)
