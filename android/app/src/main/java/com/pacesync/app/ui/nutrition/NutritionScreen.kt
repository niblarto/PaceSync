package com.pacesync.app.ui.nutrition

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pacesync.app.health.NutritionSync
import com.pacesync.app.network.NutritionApi
import com.pacesync.app.network.PaceSyncApi
import com.pacesync.app.network.dto.NutritionDashboardDto
import com.pacesync.app.network.dto.NutritionDayRow
import com.pacesync.app.network.dto.NutritionSummaryStateDto
import com.pacesync.app.network.dto.ProjectionDto
import com.pacesync.app.ui.coach.CoachMarkdown
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import kotlin.math.abs
import kotlin.math.roundToInt

// Nutrition tab — the same data as the web /nutrition page: weight (Garmin),
// food (Lose It! via Health Connect, synced from this phone), calories burnt
// (Garmin), projections and the daily AI summary. Goals are set on the web
// (Settings → Nutrition).

private val RANGES = listOf(14, 30, 90)
private const val PREFS = "nutrition_ui"
private val RED = Color(0xFFF87171)
private val GREEN = Color(0xFF6EE7B7)
private val AMBER = Color(0xFFFCD34D)

private fun kcal(v: Double?): String = if (v == null) "—" else "%,d".format(v.roundToInt())
private fun signed(v: Double): String = (if (v > 0) "+" else if (v < 0) "−" else "") + kcal(abs(v))
private fun shortDate(d: String): String = runCatching { LocalDate.parse(d).format(DateTimeFormatter.ofPattern("d MMM")) }.getOrDefault(d)
private fun longDate(d: String): String = runCatching { LocalDate.parse(d).format(DateTimeFormatter.ofPattern("d MMM yyyy")) }.getOrDefault(d)
private fun whenLabel(iso: String): String = runCatching {
    OffsetDateTime.parse(iso).atZoneSameInstant(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("EEE d MMM, HH:mm"))
}.getOrDefault(iso)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NutritionScreen(nutritionApi: NutritionApi, api: PaceSyncApi) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val prefs = remember { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }
    var range by remember { mutableIntStateOf(prefs.getInt("range", 30).takeIf { it in RANGES } ?: 30) }
    var data by remember { mutableStateOf<NutritionDashboardDto?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var weightBusy by remember { mutableStateOf(false) }
    var weightMsg by remember { mutableStateOf<String?>(null) }

    suspend fun load() {
        val resp = runCatching { nutritionApi.getDashboard(range) }.getOrNull()
        if (resp?.isSuccessful == true) { data = resp.body(); error = null } else error = "Couldn't load nutrition (${resp?.code() ?: "offline"})"
    }

    // Send this phone's latest Health Connect food first, so today's numbers
    // are current, then pull Garmin's latest weigh-in, then load.
    suspend fun fullRefresh() {
        refreshing = true
        runCatching { NutritionSync.sync(context, api, NutritionSync.PERIODIC_DAYS) }
        weightBusy = true
        val w = runCatching { nutritionApi.refreshWeight() }.getOrNull()
        weightMsg = if (w?.isSuccessful == true) w.body()?.latest?.let { "Garmin: latest ${shortDate(it.date)}" } ?: "No weigh-ins in Garmin" else "Garmin weight refresh failed"
        weightBusy = false
        load()
        refreshing = false
    }

    LaunchedEffect(Unit) { fullRefresh() }
    LaunchedEffect(range) { if (data != null) load() }

    PullToRefreshBox(isRefreshing = refreshing, onRefresh = { scope.launch { fullRefresh() } }, modifier = Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            error?.let { Text(it, color = RED, style = MaterialTheme.typography.bodySmall) }
            val d = data
            if (d == null) {
                if (error == null) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Text("Loading…", color = MaterialTheme.colorScheme.secondary)
                }
                return@Column
            }
            val cfg = d.config
            val unit = cfg.weightUnit
            if (cfg.targetWeightKg == null || cfg.goalDate == null || cfg.dailyCalorieLimit == null) {
                Text(
                    "Set your target weight, goal date and calorie limit on the web: Settings → Nutrition.",
                    style = MaterialTheme.typography.bodySmall, color = AMBER,
                )
            }
            StatTiles(d, unit, weightBusy, weightMsg) {
                scope.launch {
                    weightBusy = true
                    val w = runCatching { nutritionApi.refreshWeight() }.getOrNull()
                    weightMsg = if (w?.isSuccessful == true) w.body()?.latest?.let { "Garmin: latest ${shortDate(it.date)}" } ?: "No weigh-ins in Garmin" else "Refresh failed"
                    weightBusy = false
                    load()
                }
            }
            CaloriesCard(d, range) { r -> range = r; prefs.edit().putInt("range", r).apply() }
            WeightCard(d, unit)
            ProjectionsCard(d, unit)
            SummaryCard(nutritionApi)
            Spacer(Modifier.height(8.dp))
        }
    }
}

@Composable
private fun Section(title: String? = null, trailing: (@Composable () -> Unit)? = null, content: @Composable () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (title != null || trailing != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(title ?: "", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                    trailing?.invoke()
                }
            }
            content()
        }
    }
}

@Composable
private fun Tile(label: String, value: String, modifier: Modifier, action: (@Composable () -> Unit)? = null, sub: @Composable () -> Unit = {}) {
    Card(modifier, colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
        Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary, modifier = Modifier.weight(1f))
                action?.invoke()
            }
            Text(value, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            sub()
        }
    }
}

@Composable
private fun Small(text: String, color: Color = MaterialTheme.colorScheme.secondary) =
    Text(text, style = MaterialTheme.typography.labelSmall, color = color)

@Composable
private fun StatTiles(d: NutritionDashboardDto, unit: String, weightBusy: Boolean, weightMsg: String?, onRefreshWeight: () -> Unit) {
    val cfg = d.config
    val todayRow = d.days.find { it.date == d.today }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Tile(
                "Current weight", formatWeight(d.current?.kg, unit, exact = true), Modifier.weight(1f),
                action = {
                    if (weightBusy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    else Icon(Icons.Filled.Refresh, "Get the latest weight from Garmin", Modifier.size(18.dp).clickable(onClick = onRefreshWeight), tint = MaterialTheme.colorScheme.secondary)
                },
            ) {
                d.current?.let { c ->
                    Small("${"%.2f".format(c.kg)} kg · ${c.measuredAt?.let { whenLabel(it) } ?: shortDate(c.date)}${c.source?.let { " · $it" } ?: ""}")
                    Small("7-day avg ${formatWeight(c.avg7Kg, unit)}")
                } ?: Small("No weigh-ins yet")
                weightMsg?.let { Small(it) }
            }
            Tile("Target weight", formatWeight(cfg.targetWeightKg, unit), Modifier.weight(1f)) {
                if (cfg.targetWeightKg != null && d.current != null) {
                    Small("${formatWeightDelta(d.current.avg7Kg - cfg.targetWeightKg, unit).trimStart('+', '−')} to go")
                } else Small("Not set")
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Tile("Goal date", cfg.goalDate?.let { longDate(it) } ?: "—", Modifier.weight(1f)) {
                cfg.goalDate?.let { g ->
                    val left = runCatching { ChronoUnit.DAYS.between(LocalDate.parse(d.today), LocalDate.parse(g)) }.getOrNull()
                    Small("${left ?: "?"} days left${d.required?.let { " · needs ${formatWeightDelta(it.kgPerWeek, unit)}/wk" } ?: ""}")
                } ?: Small("Not set")
            }
            Tile("Eaten today", "${kcal(todayRow?.eaten ?: 0.0)} kcal", Modifier.weight(1f)) {
                todayRow?.net?.let { Small("net ${signed(it)} (burnt ${kcal(todayRow.burnt)})") } ?: Small("Garmin burn not in yet")
                cfg.dailyCalorieLimit?.let { lim ->
                    val left = lim - (todayRow?.eaten ?: 0.0)
                    if (left >= 0) Small("${kcal(left)} left of ${kcal(lim)}", GREEN) else Small("${kcal(-left)} over ${kcal(lim)}", RED)
                }
            }
        }
        val avg = d.averages.deficit7?.let { -it } // net = −deficit
        val lastFull = d.days.lastOrNull { it.date < d.today && it.net != null }
        Tile("Avg net, eaten − burnt (7 days)", avg?.let { "${signed(it)} kcal" } ?: "—", Modifier.fillMaxWidth()) {
            if (avg == null) Small("Needs logged days with Garmin burn")
            else {
                Small("${if (avg <= 0) "deficit" else "gain"}/day over ${d.averages.deficit7Days} logged day(s)", if (avg <= 0) GREEN else RED)
                lastFull?.let { Small("${shortDate(it.date)}: ${signed(it.net!!)}") }
            }
        }
    }
}

@Composable
private fun CaloriesCard(d: NutritionDashboardDto, range: Int, onRange: (Int) -> Unit) {
    var hidden by remember { mutableStateOf(setOf<String>()) }
    var selected by remember(d) { mutableStateOf<Int?>(null) }
    Section("Daily calories", trailing = {
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            RANGES.forEach { r -> FilterChip(selected = range == r, onClick = { onRange(r) }, label = { Text("${r}d") }) }
        }
    }) {
        CaloriesChart(d.days, d.config.dailyCalorieLimit, hidden, selected) { selected = it }
        // Legend: tap to hide/show a series.
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            listOf("net" to "Net", "eaten" to "Eaten", "exercise" to "Exercise", "burnt" to "Burnt").forEach { (key, label) ->
                val color = when (key) { "net" -> NC.netOk; "eaten" -> NC.eaten; "exercise" -> NC.exercise; else -> NC.burnt }
                val off = key in hidden
                Row(
                    Modifier.clickable { hidden = if (off) hidden - key else hidden + key },
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Box(Modifier.size(10.dp).clip(RoundedCornerShape(2.dp)).background(if (off) color.copy(alpha = 0.3f) else color))
                    Small(label, if (off) MaterialTheme.colorScheme.secondary.copy(alpha = 0.5f) else MaterialTheme.colorScheme.secondary)
                }
            }
        }
        selected?.let { i -> d.days.getOrNull(i)?.let { DayDetail(it) } } ?: Small("Tap a day for details. Net = eaten − burnt (green deficit, red gain).")
        val a = d.averages
        Small(
            "Last ${a.windowDays} days (not today): avg eaten ${kcal(a.eaten)} on ${a.loggedDays} logged days · avg burnt ${kcal(a.burnt)} · " +
                "avg exercise ${kcal(a.exercise)} · avg net ${a.net?.let { signed(it) } ?: "—"}",
        )
    }
}

@Composable
private fun DayDetail(r: NutritionDayRow) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Color(0x22000000)).padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(longDate(r.date), style = MaterialTheme.typography.labelLarge)
        Small("Eaten ${kcal(r.eaten)} · Burnt ${kcal(r.burnt)}${r.resting?.let { " (${kcal(it)} resting)" } ?: ""} · Exercise ${kcal(r.exercise)}")
        r.net?.let { Small("Net (eaten − burnt): ${signed(it)} kcal (${if (it <= 0) "deficit" else "gain"})", if (it <= 0) GREEN else RED) }
        r.proteinG?.let { Small("P ${it.roundToInt()} g · C ${(r.carbsG ?: 0.0).roundToInt()} g · F ${(r.fatG ?: 0.0).roundToInt()} g") }
    }
}

@Composable
private fun WeightCard(d: NutritionDashboardDto, unit: String) {
    val cur = d.current ?: return Section("Weight and projections") { Small("No weigh-ins yet.") }
    val today = LocalDate.parse(d.today)
    val chart = remember(d) {
        val start = today.minusDays(90)
        val weights = d.weights.mapNotNull { w -> runCatching { LocalDate.parse(w.date) to w.kg }.getOrNull() }.filter { !it.first.isBefore(start) }
        val goal = d.config.goalDate?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
        val ends = mutableListOf(today.plusDays(60))
        goal?.let { ends += it }
        d.projections.mapNotNull { p -> p.hitDate?.let { runCatching { LocalDate.parse(it) }.getOrNull() } }.forEach { ends += it }
        val end = minOf(ends.max(), today.plusDays(730))
        WeightChartData(weights, today, cur.avg7Kg, d.projections.map { ProjLine(it.method, it.kgPerWeek) }, d.config.targetWeightKg, goal, end)
    }
    var selected by remember(d) { mutableStateOf<LocalDate?>(null) }
    Section("Weight and projections") {
        WeightChart(chart, unit, selected) { selected = it }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            LegendDot(NC.weight, "Weigh-ins")
            d.projections.forEach { LegendDot(NC.projection(it.method), it.label) }
        }
        val s = selected
        if (s == null) Small("Tap the chart for a date's values.")
        else Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Color(0x22000000)).padding(8.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(s.format(DateTimeFormatter.ofPattern("d MMM yyyy")), style = MaterialTheme.typography.labelLarge)
            // Nearest weigh-in within 2 days of the tap.
            val near = chart.weights.minByOrNull { abs(ChronoUnit.DAYS.between(it.first, s)) }?.takeIf { abs(ChronoUnit.DAYS.between(it.first, s)) <= 2 }
            if (!s.isAfter(today)) {
                near?.let { Small("Weigh-in ${it.first.format(DateTimeFormatter.ofPattern("d MMM"))}: ${formatWeight(it.second, unit)}") } ?: Small("No weigh-in near this date")
            } else {
                chart.lines.forEach { l ->
                    val p = d.projections.first { it.method == l.method }
                    Small("${p.label}: ${formatWeight(projectedKg(chart, l, s), unit)}", NC.projection(l.method))
                }
            }
        }
    }
}

@Composable
private fun LegendDot(color: Color, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(color))
        Small(label)
    }
}

@Composable
private fun ProjectionsCard(d: NutritionDashboardDto, unit: String) {
    val cfg = d.config
    Section("Projections") {
        if (d.projections.isEmpty()) {
            Small("Not enough data yet. Projections need a few weigh-ins or logged days.")
            return@Section
        }
        d.projections.forEach { p -> ProjectionRow(p, cfg.goalDate, cfg.targetWeightKg, unit) }
        d.required?.let { r ->
            Text(
                "To reach your target by ${longDate(cfg.goalDate ?: "")} you need ${formatWeightDelta(r.kgPerWeek, unit)}/wk, a daily " +
                    "${if (r.dailyBalance <= 0) "deficit" else "surplus"} of ${kcal(abs(r.dailyBalance))} kcal" +
                    (r.intake?.let { " (about ${kcal(it)} kcal eaten/day at your average burn)" } ?: "") + ".",
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Small("Based on the last ${cfg.trendDays} days, starting from your 7-day average weight. Max 2 lb/week assumed.")
    }
}

@Composable
private fun ProjectionRow(p: ProjectionDto, goalDate: String?, targetKg: Double?, unit: String) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Color(0x22000000)).padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(10.dp).clip(CircleShape).background(NC.projection(p.method)))
            Text(p.label, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(start = 6.dp).weight(1f))
            Small("${formatWeightDelta(p.kgPerWeek, unit)}/wk")
        }
        Small(p.basis)
        if (p.capped) Small("Measured ${formatWeightDelta(p.rawKgPerWeek, unit)}/wk; dates assume the 2 lb/wk maximum.", AMBER)
        Row {
            Column(Modifier.weight(1f)) {
                Small("Projected weight on target date${goalDate?.let { " (${shortDate(it)})" } ?: ""}")
                Text(formatWeight(p.weightAtGoalKg, unit), style = MaterialTheme.typography.bodyMedium)
                if (p.weightAtGoalKg != null && targetKg != null) {
                    val diff = p.weightAtGoalKg - targetKg
                    if (abs(diff) < 0.05) Small("On target", GREEN)
                    else Small("${formatWeightDelta(abs(diff), unit).trimStart('+')} ${if (diff > 0) "above" else "below"} target", if (diff <= 0.05) GREEN else AMBER)
                }
            }
            Column(Modifier.weight(1f)) {
                Small("Target reached")
                val (txt, color) = when {
                    targetKg == null -> "—" to MaterialTheme.colorScheme.onSurface
                    p.hitStatus == "reached" -> "Already there" to GREEN
                    p.hitStatus == "never" -> "Not at this rate" to RED
                    else -> longDate(p.hitDate ?: "") to (if (goalDate != null && (p.hitDate ?: "") <= goalDate) GREEN else AMBER)
                }
                Text(txt, style = MaterialTheme.typography.bodyMedium, color = color)
            }
        }
    }
}

// Daily AI summary of the last 14 days. While one is due, asks the server
// every minute (it writes it once the AI DJ service answers); every 10s while
// it's being written.
@Composable
private fun SummaryCard(nutritionApi: NutritionApi) {
    var s by remember { mutableStateOf<NutritionSummaryStateDto?>(null) }
    var failed by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        var first = true
        while (true) {
            val resp = runCatching { if (first) nutritionApi.getSummary() else nutritionApi.ensureSummary() }.getOrNull()
            val body = resp?.body()
            if (resp?.isSuccessful == true && body != null) { s = body; failed = null } else failed = "Couldn't load the summary"
            if (body != null && first && body.due && !body.writing) { first = false; continue }
            first = false
            if (body != null && !body.due && !body.writing) break
            delay(if (body?.writing == true) 10_000 else 60_000)
        }
    }
    val st = s
    Section("🧠 AI summary · last 14 days", trailing = { st?.summary?.let { Small(whenLabel(it.createdAt)) } }) {
        if (st?.writing == true) Text("Writing today's summary…", color = GREEN, style = MaterialTheme.typography.bodySmall)
        if (st?.due == true && !st.writing) {
            Text(
                "Today's summary is due. ${if (st.result?.status == "unavailable") "${st.result.reason}; " else ""}checking again every minute.",
                color = AMBER, style = MaterialTheme.typography.bodySmall,
            )
        }
        if (st?.error != null && !st.writing) Text("Last attempt failed: ${st.error}", color = RED, style = MaterialTheme.typography.bodySmall)
        failed?.let { Text(it, color = RED, style = MaterialTheme.typography.bodySmall) }
        when {
            st == null -> Small("Loading…")
            st.summary != null -> {
                CoachMarkdown(st.summary.content)
                Small(listOfNotNull(st.summary.model, if (!st.due) st.nextAt?.let { "next from ${whenLabel(it)}" } else null).joinToString(" · "))
            }
            else -> Small("No summary yet.")
        }
    }
}
