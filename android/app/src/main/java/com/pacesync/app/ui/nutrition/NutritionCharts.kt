package com.pacesync.app.ui.nutrition

import android.graphics.Paint
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import com.pacesync.app.network.dto.NutritionDayRow
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

// Hand-drawn charts for the Nutrition tab (the app has no chart library).

object NC {
    val eaten = Color(0xFFF59E0B)
    val burnt = Color(0xFF38BDF8)
    val exercise = Color(0xFF34D399)
    val netOk = Color(0xFF22C55E)
    val netOver = Color(0xFFEF4444)
    val limit = Color(0xFFF87171)
    val target = Color(0xFF34D399)
    val weight = Color(0xFFE2E8F0)
    val axis = Color(0xFF64748B)
    val grid = Color(0x14FFFFFF)
    fun projection(method: String) = when (method) {
        "trend" -> Color(0xFFA78BFA)
        "energy" -> Color(0xFFF59E0B)
        else -> Color(0xFF38BDF8)
    }
}

private val SHORT = DateTimeFormatter.ofPattern("d MMM")

private fun labelPaint(color: Color, sizePx: Float, align: Paint.Align = Paint.Align.LEFT) = Paint().apply {
    this.color = color.toArgb(); textSize = sizePx; isAntiAlias = true; textAlign = align
}

private fun DrawScope.text(s: String, x: Float, y: Float, paint: Paint) = drawContext.canvas.nativeCanvas.drawText(s, x, y, paint)

private val DASH = PathEffect.dashPathEffect(floatArrayOf(14f, 10f))
private val DOT = PathEffect.dashPathEffect(floatArrayOf(4f, 10f))

// ── Daily calories: net (eaten − burnt, green deficit / red gain), eaten,
// exercise and burnt bars per day, with the daily limit line. Tap a day to
// select it. ──
@Composable
fun CaloriesChart(
    days: List<NutritionDayRow>,
    limit: Double?,
    hidden: Set<String>,
    selected: Int?,
    onSelect: (Int) -> Unit,
) {
    val series = listOf("net", "eaten", "exercise", "burnt").filter { it !in hidden }
    Canvas(
        Modifier.fillMaxWidth().height(240.dp).pointerInput(days.size) {
            detectTapGestures { o ->
                val left = 44.dp.toPx()
                val w = (size.width - left) / days.size.coerceAtLeast(1)
                val i = ((o.x - left) / w).toInt()
                if (i in days.indices) onSelect(i)
            }
        },
    ) {
        if (days.isEmpty()) return@Canvas
        val left = 44.dp.toPx()
        val bottom = size.height - 20.dp.toPx()
        val top = 8.dp.toPx()
        val values = days.flatMap { d -> listOfNotNull(d.net, d.eaten, d.exercise, d.burnt) } + listOfNotNull(limit)
        val hi = (values.maxOrNull() ?: 1000.0).coerceAtLeast(500.0) * 1.08
        val lo = min(0.0, values.minOrNull() ?: 0.0) * 1.08
        fun y(v: Double) = (bottom - (v - lo) / (hi - lo) * (bottom - top)).toFloat()
        val small = labelPaint(NC.axis, 10.dp.toPx())

        // Grid + y labels
        val step = niceStep(hi - lo)
        var g = Math.ceil(lo / step) * step
        while (g <= hi) {
            drawLine(NC.grid, Offset(left, y(g)), Offset(size.width, y(g)), 1f)
            text("%,d".format(g.toInt()), 2f, y(g) + 4.dp.toPx(), small)
            g += step
        }
        drawLine(Color(0x33FFFFFF), Offset(left, y(0.0)), Offset(size.width, y(0.0)), 1.5f)

        val slot = (size.width - left) / days.size
        selected?.let { i -> drawRect(Color(0x14FFFFFF), Offset(left + slot * i, top), Size(slot, bottom - top)) }
        val barW = (slot * 0.8f / series.size.coerceAtLeast(1)).coerceAtLeast(1f)
        days.forEachIndexed { i, d ->
            var x = left + slot * i + slot * 0.1f
            for (s in series) {
                val v = when (s) { "net" -> d.net; "eaten" -> d.eaten; "exercise" -> d.exercise; else -> d.burnt }
                if (v != null) {
                    val color = when (s) {
                        "net" -> if (v > 0) NC.netOver else NC.netOk
                        "eaten" -> NC.eaten
                        "exercise" -> NC.exercise
                        else -> NC.burnt
                    }
                    val y0 = y(0.0); val y1 = y(v)
                    drawRect(color, Offset(x, min(y0, y1)), Size(barW, abs(y1 - y0).coerceAtLeast(1f)))
                }
                x += barW
            }
        }
        if (limit != null) {
            drawLine(NC.limit, Offset(left, y(limit)), Offset(size.width, y(limit)), 2f, pathEffect = DASH)
            text("Limit ${"%,d".format(limit.toInt())}", size.width - 4.dp.toPx(), y(limit) - 4.dp.toPx(), labelPaint(NC.limit, 10.dp.toPx(), Paint.Align.RIGHT))
        }
        // x labels: first, middle, last
        val idxs = listOf(0, days.size / 2, days.size - 1).distinct()
        for (i in idxs) {
            val label = runCatching { LocalDate.parse(days[i].date).format(SHORT) }.getOrDefault(days[i].date)
            val align = when (i) { 0 -> Paint.Align.LEFT; days.size - 1 -> Paint.Align.RIGHT; else -> Paint.Align.CENTER }
            val x = when (i) { 0 -> left; days.size - 1 -> size.width; else -> left + slot * (i + 0.5f) }
            text(label, x, size.height - 4.dp.toPx(), labelPaint(NC.axis, 10.dp.toPx(), align))
        }
    }
}

private fun niceStep(range: Double): Double {
    val raw = range / 4
    val mag = Math.pow(10.0, Math.floor(Math.log10(raw.coerceAtLeast(1.0))))
    return listOf(1.0, 2.0, 2.5, 5.0, 10.0).map { it * mag }.first { it >= raw }
}

// ── Weight: weigh-ins (last 90 days) + a dashed projection line per method
// from today's 7-day average, target line and goal date. Tap for a date. ──
data class ProjLine(val method: String, val kgPerWeek: Double)

data class WeightChartData(
    val weights: List<Pair<LocalDate, Double>>,
    val today: LocalDate,
    val anchorKg: Double,
    val lines: List<ProjLine>,
    val targetKg: Double?,
    val goalDate: LocalDate?,
    val end: LocalDate,
)

fun projectedKg(d: WeightChartData, line: ProjLine, date: LocalDate): Double {
    val days = ChronoUnit.DAYS.between(d.today, date).toDouble()
    var kg = d.anchorKg + line.kgPerWeek / 7 * days
    if (d.targetKg != null && line.kgPerWeek < 0 && d.anchorKg > d.targetKg) kg = max(kg, d.targetKg)
    return kg
}

@Composable
fun WeightChart(data: WeightChartData, unit: String, selected: LocalDate?, onSelect: (LocalDate) -> Unit) {
    val start = data.weights.firstOrNull()?.first ?: data.today.minusDays(30)
    val totalDays = ChronoUnit.DAYS.between(start, data.end).toFloat().coerceAtLeast(1f)
    Canvas(
        Modifier.fillMaxWidth().height(240.dp).pointerInput(data) {
            detectTapGestures { o ->
                val left = 52.dp.toPx()
                val frac = ((o.x - left) / (size.width - left)).coerceIn(0f, 1f)
                onSelect(start.plusDays((frac * totalDays).toLong()))
            }
        },
    ) {
        val left = 52.dp.toPx()
        val bottom = size.height - 20.dp.toPx()
        val top = 8.dp.toPx()
        val ys = data.weights.map { it.second } + data.lines.flatMap { l -> listOf(data.anchorKg, projectedKg(data, l, data.end)) } + listOfNotNull(data.targetKg)
        val loRaw = ys.minOrNull() ?: 70.0
        val hiRaw = ys.maxOrNull() ?: 90.0
        val pad = max(0.5, (hiRaw - loRaw) * 0.08)
        val lo = loRaw - pad; val hi = hiRaw + pad
        fun x(d: LocalDate) = left + ChronoUnit.DAYS.between(start, d) / totalDays * (size.width - left)
        fun y(kg: Double) = (bottom - (kg - lo) / (hi - lo) * (bottom - top)).toFloat()
        val small = labelPaint(NC.axis, 10.dp.toPx())

        for (k in 0..4) {
            val kg = lo + (hi - lo) * k / 4
            drawLine(NC.grid, Offset(left, y(kg)), Offset(size.width, y(kg)), 1f)
            text(weightTick(kg, unit), 2f, y(kg) + 4.dp.toPx(), small)
        }
        data.targetKg?.let {
            drawLine(NC.target, Offset(left, y(it)), Offset(size.width, y(it)), 2f, pathEffect = DASH)
            text("Target", left + 4.dp.toPx(), y(it) - 4.dp.toPx(), labelPaint(NC.target, 10.dp.toPx()))
        }
        data.goalDate?.let {
            if (!it.isBefore(start) && !it.isAfter(data.end)) {
                drawLine(NC.target, Offset(x(it), top), Offset(x(it), bottom), 2f, pathEffect = DOT)
                text("Goal", x(it) - 4.dp.toPx(), top + 10.dp.toPx(), labelPaint(NC.target, 10.dp.toPx(), Paint.Align.RIGHT))
            }
        }
        drawLine(Color(0x33FFFFFF), Offset(x(data.today), top), Offset(x(data.today), bottom), 1.5f)
        selected?.let { drawLine(Color(0x55FFFFFF), Offset(x(it), top), Offset(x(it), bottom), 1f) }

        for (l in data.lines) {
            val c = NC.projection(l.method)
            val from = Offset(x(data.today), y(data.anchorKg))
            // A losing line runs to the target, then stays flat on it.
            val hit = if (data.targetKg != null && l.kgPerWeek < 0 && data.anchorKg > data.targetKg) {
                data.today.plusDays(((data.targetKg - data.anchorKg) / (l.kgPerWeek / 7)).toLong())
            } else null
            if (hit != null && hit.isBefore(data.end)) {
                val at = Offset(x(hit), y(data.targetKg!!))
                drawLine(c, from, at, 4f, pathEffect = DASH)
                drawLine(c, at, Offset(x(data.end), y(data.targetKg)), 4f, pathEffect = DASH)
            } else {
                drawLine(c, from, Offset(x(data.end), y(projectedKg(data, l, data.end))), 4f, pathEffect = DASH)
            }
        }
        for ((d, kg) in data.weights) drawCircle(NC.weight, 3.dp.toPx(), Offset(x(d), y(kg)))

        text(start.format(SHORT), left, size.height - 4.dp.toPx(), small)
        text(data.end.format(SHORT), size.width, size.height - 4.dp.toPx(), labelPaint(NC.axis, 10.dp.toPx(), Paint.Align.RIGHT))
        if (x(data.today) - left > 60.dp.toPx() && size.width - x(data.today) > 60.dp.toPx()) {
            text(data.today.format(SHORT), x(data.today), size.height - 4.dp.toPx(), labelPaint(NC.axis, 10.dp.toPx(), Paint.Align.CENTER))
        }
    }
}
