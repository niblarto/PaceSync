package com.pacesync.app.network.dto

import kotlinx.serialization.Serializable

// Mirrors the server's "Snack Me!" (lib/snack-builder.ts): POST api/nutrition/snack-me gives snacks from the Lose It!
// history that fit under the calories left; POST api/nutrition/create-meal/accept logs one item to a meal.

// No defaults on request classes on purpose: the JSON encoder skips default-valued fields.
@Serializable
data class SnackMeRequest(val kcalLeft: Double)

@Serializable
data class SnackItemDto(
    val name: String,
    val brand: String? = null,
    val amount: Double = 0.0,
    val units: String = "",
    val label: String = "",
    val kcal: Double = 0.0,
    val proteinG: Double = 0.0,
    val carbsG: Double = 0.0,
    val fatG: Double = 0.0,
)

// kind "food": one snack in the portion usually logged; "day": a whole snack session from one day.
@Serializable
data class SnackDto(
    val kind: String,
    val name: String,
    val items: List<SnackItemDto> = emptyList(),
    val totals: LoseItTotalsDto = LoseItTotalsDto(),
    val times: Int = 0,
    val last: String = "",
)

@Serializable
data class SnackMeDto(
    val foods: List<SnackDto> = emptyList(),
    val days: List<SnackDto> = emptyList(),
    val fitFoods: Int = 0,
    val fitDays: Int = 0,
)

@Serializable
data class AcceptItemBody(val name: String, val brand: String?, val amount: Double, val units: String, val kcal: Double)

@Serializable
data class AcceptItemRequest(val date: String, val meal: Int, val item: AcceptItemBody)

// What was really logged, after matching the food in Lose It!.
@Serializable
data class LoggedItemDto(
    val name: String = "",
    val label: String = "",
    val kcal: Double = 0.0,
    val proteinG: Double = 0.0,
    val carbsG: Double = 0.0,
    val fatG: Double = 0.0,
)

@Serializable
data class AcceptItemDto(val logged: LoggedItemDto = LoggedItemDto())
