package com.pacesync.app.ui.nutrition

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.roundToInt

// Mirrors lib/weight-format.ts. Weights are kg everywhere; unit is "st",
// "lb" or "kg" from Settings → Nutrition on the web.

const val LB_PER_KG = 2.20462

fun formatWeight(kg: Double?, unit: String, exact: Boolean = false): String {
    if (kg == null || kg.isNaN()) return "—"
    val dp = 1
    return when (unit) {
        "kg" -> "%.${dp}f kg".format(kg)
        "lb" -> "%.${dp}f lb".format(kg * LB_PER_KG)
        else -> {
            val totalLb = Math.round(kg * LB_PER_KG * 10) / 10.0 // round first, so 12 st 13.99 lb reads 13 st 0.0 lb
            val st = floor(totalLb / 14).toInt()
            "$st st ${"%.1f".format(totalLb - st * 14)} lb"
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

// Short axis label: "13st 2", "185", "84". Stone is rounded to whole pounds
// first, so a whole stone reads "13st 0", never "12st 14".
fun weightTick(kg: Double, unit: String): String = when (unit) {
    "kg" -> kg.roundToInt().toString()
    "lb" -> (kg * LB_PER_KG).roundToInt().toString()
    else -> {
        val totalLb = (kg * LB_PER_KG).roundToInt()
        "${totalLb / 14}st ${totalLb % 14}"
    }
}

// Weight written beside a chart point: "12st 9.5", "185.3 lb", "84.1 kg".
fun weightShort(kg: Double, unit: String): String = when (unit) {
    "kg" -> "%.1f kg".format(kg)
    "lb" -> "%.1f lb".format(kg * LB_PER_KG)
    else -> {
        val totalLb = kg * LB_PER_KG
        var st = floor(totalLb / 14).toInt()
        var lb = totalLb - st * 14
        if ("%.1f".format(lb).toDouble() >= 14.0) { st += 1; lb -= 14 }
        "${st}st ${"%.1f".format(lb)}"
    }
}

// Where the weight chart's y axis gets its grid lines and labels (kg). In
// stone: every half stone (7 lb), so the labels are only ever whole or half
// stones; every whole stone instead if the range is so big that would crowd.
// Other units: five even steps.
fun weightTickValues(lo: Double, hi: Double, unit: String): List<Double> {
    val even = (0..4).map { lo + (hi - lo) * it / 4 }
    if (unit != "st") return even
    val loLb = lo * LB_PER_KG
    val hiLb = hi * LB_PER_KG
    val step = if ((hiLb - loLb) / 7.0 > 12) 14.0 else 7.0
    val ticks = mutableListOf<Double>()
    var lb = ceil(loLb / step) * step
    while (lb <= hiLb + 1e-9) {
        ticks += lb / LB_PER_KG
        lb += step
    }
    return if (ticks.isEmpty()) even else ticks
}
