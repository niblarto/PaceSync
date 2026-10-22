package com.pacesync.app.ui.nutrition

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.roundToInt

// Mirrors lib/weight-format.ts. Weights are kg everywhere; unit is "st",
// "lb" or "kg" from Settings → Nutrition on the web.

const val LB_PER_KG = 2.20462

fun formatWeight(kg: Double?, unit: String, exact: Boolean = false): String {
    if (kg == null || kg.isNaN()) return "—"
    val dp = if (exact) 2 else 1
    return when (unit) {
        "kg" -> "%.${dp}f kg".format(kg)
        "lb" -> "%.${dp}f lb".format(kg * LB_PER_KG)
        else -> {
            val totalLb = kg * LB_PER_KG
            var st = floor(totalLb / 14).toInt()
            var lb = totalLb - st * 14
            if ("%.${dp}f".format(lb).toDouble() >= 14.0) { st += 1; lb -= 14 }
            "$st st ${"%.${dp}f".format(lb)} lb"
        }
    }
}

// Signed change: "−1.2 lb", "+0.3 lb", "−1 st 2.0 lb", "−0.50 kg".
fun formatWeightDelta(kg: Double, unit: String): String {
    val sign = if (kg > 0) "+" else if (kg < 0) "−" else ""
    val a = abs(kg)
    if (unit == "kg") return "$sign${"%.2f".format(a)} kg"
    val lb = a * LB_PER_KG
    if (unit == "st" && lb >= 14) {
        val st = floor(lb / 14).toInt()
        return "$sign$st st ${"%.1f".format(lb - st * 14)} lb"
    }
    return "$sign${"%.1f".format(lb)} lb"
}

// Short axis label: "13st 2", "185", "84".
fun weightTick(kg: Double, unit: String): String = when (unit) {
    "kg" -> kg.roundToInt().toString()
    "lb" -> (kg * LB_PER_KG).roundToInt().toString()
    else -> {
        val lb = kg * LB_PER_KG
        val st = floor(lb / 14).toInt()
        "${st}st ${(lb - st * 14).roundToInt()}"
    }
}
