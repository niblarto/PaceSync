package com.pacesync.app.ui.nutrition

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ActivityInfo
import android.graphics.Rect
import android.view.View
import android.view.WindowManager
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.DialogWindowProvider
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculateCentroidSize
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.material3.TextButton
import androidx.compose.material3.Button
import android.widget.Toast
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pacesync.app.R
import com.pacesync.app.network.NutritionApi
import com.pacesync.app.network.PaceSyncApi
import com.pacesync.app.network.dto.NutritionDashboardDto
import com.pacesync.app.network.dto.NutritionDayRow
import com.pacesync.app.network.dto.NutritionSummaryStateDto
import com.pacesync.app.network.dto.ProjectionDto
import com.pacesync.app.ui.coach.CoachMarkdown
import com.pacesync.app.ui.common.ScrollingBackground
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

// Nutrition tab — the same data as the web /nutrition page: weight (Garmin),
// food (Lose It!, synced by the server), calories burnt
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

// Survives the activity being recreated when a chart rotates to landscape,
// so the page doesn't reload (and re-sync) every time.
private object NutritionCache {
    var data: NutritionDashboardDto? = null
    var at: Long = 0L
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NutritionScreen(nutritionApi: NutritionApi, api: PaceSyncApi) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val prefs = remember { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }
    var range by remember { mutableIntStateOf(prefs.getInt("range", 30).takeIf { it in RANGES } ?: 30) }
    var data by remember { mutableStateOf(NutritionCache.data) }
    // Which chart is open full screen ("calories" / "weight"); saveable so it
    // reopens after the rotation recreates the activity.
    var fullscreen by rememberSaveable { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var weightBusy by remember { mutableStateOf(false) }
    var weightMsg by remember { mutableStateOf<String?>(null) }
    var diaryKey by remember { mutableIntStateOf(0) } // bumped by each full refresh to reload the food diary

    suspend fun load() {
        val resp = runCatching { nutritionApi.getDashboard(range) }.getOrNull()
        if (resp?.isSuccessful == true) {
            data = resp.body(); error = null
            NutritionCache.data = data; NutritionCache.at = System.currentTimeMillis()
        } else error = "Couldn't load nutrition (${resp?.code() ?: "offline"})"
    }

    // Pull Garmin's latest weigh-in, then load (the server syncs today's
    // Lose It! food itself when the dashboard loads).
    suspend fun fullRefresh() {
        refreshing = true
        weightBusy = true
        val w = runCatching { nutritionApi.refreshWeight() }.getOrNull()
        weightMsg = if (w?.isSuccessful == true) w.body()?.latest?.let { "Garmin: latest ${shortDate(it.date)}" } ?: "No weigh-ins in Garmin" else "Garmin weight refresh failed"
        weightBusy = false
        load()
        diaryKey++
        refreshing = false
    }

    LaunchedEffect(Unit) {
        // Skip the full refresh when we already have fresh data (e.g. coming
        // back from a full-screen chart).
        if (NutritionCache.data == null || System.currentTimeMillis() - NutritionCache.at > 60_000) fullRefresh()
    }
    LaunchedEffect(range) { if (data != null) load() }

    val scrollState = rememberScrollState()
    ScrollingBackground(scrollState, imageRes = R.drawable.apk_background_summary) {
    PullToRefreshBox(isRefreshing = refreshing, onRefresh = { scope.launch { fullRefresh() } }, modifier = Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxSize().verticalScroll(scrollState).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // Pulls Garmin's latest weigh-in and reloads (the server re-reads
            // today's Lose It! food) — same as pull-to-refresh.
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        if (refreshing) "Refreshing…" else "Refresh nutrition & weight",
                        style = MaterialTheme.typography.titleSmall,
                    )
                    val status = listOfNotNull(weightMsg).joinToString(" · ")
                    if (status.isNotEmpty()) Text(status, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary)
                }
                if (refreshing) CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                else IconButton(onClick = { scope.launch { fullRefresh() } }) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh all nutrition and weight data") }
            }
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
            // onChanged: Snack Me! added food, so the day's totals above need reloading too.
            FoodDiaryCard(nutritionApi, diaryKey, d.macroPlan, d.days, onChanged = { scope.launch { load() } })
            CaloriesCard(d, range, onExpand = { fullscreen = "calories" }) { r -> range = r; prefs.edit().putInt("range", r).apply() }
            WeightCard(d, unit, onExpand = { fullscreen = "weight" })
            ProjectionsCard(d, unit)
            SummaryCard(nutritionApi)
            Spacer(Modifier.height(8.dp))
        }
    }
    }

    val d = data
    if (fullscreen != null && d != null) {
        val close = { fullscreen = null }
        when (fullscreen) {
            "calories" -> CaloriesFullscreen(d, range, onRange = { r -> range = r; prefs.edit().putInt("range", r).apply() }, refreshing = refreshing, onRefresh = { if (!refreshing) scope.launch { fullRefresh() } }, onClose = close)
            else -> WeightFullscreen(d, d.config.weightUnit, refreshing = refreshing, onRefresh = { if (!refreshing) scope.launch { fullRefresh() } }, onClose = close)
        }
    }
}

@Composable
private fun Section(title: String? = null, trailing: (@Composable () -> Unit)? = null, content: @Composable () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.88f))) {
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
    Card(modifier, colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.88f))) {
        Column(Modifier.fillMaxSize().padding(10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
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
        // Each row's tiles match the tallest one, so no background shows between them.
        Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Tile(
                "Current weight", formatWeight(d.current?.kg, unit, exact = true), Modifier.weight(1f).fillMaxHeight(),
                action = {
                    if (weightBusy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    else Icon(Icons.Filled.Refresh, "Get the latest weight from Garmin", Modifier.size(18.dp).clickable(onClick = onRefreshWeight), tint = MaterialTheme.colorScheme.secondary)
                },
            ) {
                d.current?.let { c ->
                    Small("${"%.2f".format(c.kg)} kg · ${c.measuredAt?.let { whenLabel(it) } ?: shortDate(c.date)}${c.source?.let { " · $it" } ?: ""}${if (c.postRun) " · post-activity" else ""}")
                    Small("7-day avg ${formatWeight(c.avg7Kg, unit)}")
                    if (c.postRun && c.regularKg != null) Small("Morning ${formatWeight(c.regularKg, unit)}")
                } ?: Small("No weigh-ins yet")
                weightMsg?.let { Small(it) }
            }
            Tile("Target weight", formatWeight(cfg.targetWeightKg, unit), Modifier.weight(1f).fillMaxHeight()) {
                if (cfg.targetWeightKg != null && d.current != null) {
                    Small("${formatWeightDelta(d.current.avg7Kg - cfg.targetWeightKg, unit).trimStart('+', '−')} to go")
                } else Small("Not set")
            }
        }
        Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Tile("Goal date", cfg.goalDate?.let { longDate(it) } ?: "—", Modifier.weight(1f).fillMaxHeight()) {
                cfg.goalDate?.let { g ->
                    val left = runCatching { ChronoUnit.DAYS.between(LocalDate.parse(d.today), LocalDate.parse(g)) }.getOrNull()
                    Small("${left ?: "?"} days left${d.required?.let { " · needs ${formatWeightDelta(it.kgPerWeek, unit)}/wk" } ?: ""}")
                } ?: Small("Not set")
            }
            Tile("Eaten today", "${kcal(todayRow?.eaten ?: 0.0)} kcal", Modifier.weight(1f).fillMaxHeight()) {
                todayRow?.net?.let { Small("net ${signed(it)} (burnt ${kcal(todayRow.burnt)}${if (todayRow.partial) " so far" else ""})") } ?: Small("Garmin burn not in yet")
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
private fun CaloriesCard(d: NutritionDashboardDto, range: Int, onExpand: () -> Unit, onRange: (Int) -> Unit) {
    var hidden by remember { mutableStateOf(setOf<String>()) }
    Section("Daily calories", trailing = {
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            RANGES.forEach { r -> FilterChip(selected = range == r, onClick = { onRange(r) }, label = { Text("${r}d") }) }
        }
    }) {
        CaloriesChart(d.days, d.config.dailyCalorieLimit, d.config.minDailyCalories, hidden, selected = null, onTap = { onExpand() })
        CaloriesLegend(hidden) { hidden = it }
        val a = d.averages
        Small(
            "Last ${a.windowDays} days (not today): avg eaten ${kcal(a.eaten)} on ${a.loggedDays} logged days · avg burnt ${kcal(a.burnt)} · " +
                "avg exercise ${kcal(a.exercise)} · avg net ${a.net?.let { signed(it) } ?: "—"}",
        )
    }
}

// Legend: tap an entry to hide/show that series.
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CaloriesLegend(hidden: Set<String>, onChange: (Set<String>) -> Unit) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            listOf("net" to "Net", "eaten" to "Eaten", "exercise" to "Exercise", "burnt" to "Burnt").forEach { (key, label) ->
                val color = when (key) { "net" -> NC.netLine; "eaten" -> NC.eaten; "exercise" -> NC.exercise; else -> NC.burnt }
                val off = key in hidden
                Row(
                    Modifier.clickable { onChange(if (off) hidden - key else hidden + key) },
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Box(Modifier.size(10.dp).clip(RoundedCornerShape(2.dp)).background(if (off) color.copy(alpha = 0.3f) else color))
                    Small(label, if (off) MaterialTheme.colorScheme.secondary.copy(alpha = 0.5f) else MaterialTheme.colorScheme.secondary)
                }
            }
        }
}

@Composable
private fun DayDetail(r: NutritionDayRow) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Color(0x22000000)).padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(longDate(r.date), style = MaterialTheme.typography.labelLarge)
        Small("Eaten ${kcal(r.eaten)} · Burnt${if (r.partial) " so far" else ""} ${kcal(r.burnt)}${r.resting?.let { " (${kcal(it)} resting)" } ?: ""} · Exercise ${kcal(r.exercise)}")
        r.net?.let { Small("Net (eaten − burnt)${if (r.partial) " so far" else ""}: ${signed(it)} kcal (${if (it <= 0) "deficit" else "gain"})", if (it <= 0) GREEN else RED) }
        r.proteinG?.let { Small("P ${it.roundToInt()} g · C ${(r.carbsG ?: 0.0).roundToInt()} g · F ${(r.fatG ?: 0.0).roundToInt()} g") }
    }
}

private fun weightChartData(d: NutritionDashboardDto): WeightChartData? {
    val cur = d.current ?: return null
    val today = LocalDate.parse(d.today)
    return run {
        val start = today.minusDays(56)
        val weights = d.weights.mapNotNull { w -> runCatching { LocalDate.parse(w.date) to w.kg }.getOrNull() }.filter { !it.first.isBefore(start) }
        val postWeights = d.postRunWeights.mapNotNull { w -> runCatching { LocalDate.parse(w.date) to w.kg }.getOrNull() }.filter { !it.first.isBefore(start) }
        val postFit = d.postRunFit?.let { f ->
            runCatching { TrendFit(LocalDate.parse(f.startDate), f.startKg, LocalDate.parse(f.endDate), f.endKg) }.getOrNull()
        }
        val goal = d.config.goalDate?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
        val ends = mutableListOf(today.plusDays(60))
        goal?.let { ends += it }
        d.projections.mapNotNull { p -> p.hitDate?.let { runCatching { LocalDate.parse(it) }.getOrNull() } }.forEach { ends += it }
        val end = minOf(ends.max(), today.plusDays(730))
        val fit = d.trendFit?.let { f ->
            runCatching { TrendFit(LocalDate.parse(f.startDate), f.startKg, LocalDate.parse(f.endDate), f.endKg) }.getOrNull()
        }
        val fit7 = d.trendFit7?.let { f ->
            runCatching { TrendFit(LocalDate.parse(f.startDate), f.startKg, LocalDate.parse(f.endDate), f.endKg) }.getOrNull()
        }
        WeightChartData(weights, today, cur.avg7Kg, d.projections.map { ProjLine(it.method, it.kgPerWeek, it.anchorKg) }, d.config.targetWeightKg, goal, end, fit, postWeights, postFit, fit7)
    }
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun WeightLegend(d: NutritionDashboardDto) {
    // Wraps onto a second line when the entries don't fit across (a plain Row squeezed the last
    // ones to nothing and broke their text letter by letter into a very tall column).
    FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        LegendDot(NC.weight, "Weigh-ins")
        LegendDot(NC.postRun, "Post-activity")
        LegendDot(NC.avg, "7-day avg")
        d.projections.forEach { LegendDot(NC.projection(it.method), it.label) }
    }
}

@Composable
private fun WeightCard(d: NutritionDashboardDto, unit: String, onExpand: () -> Unit) {
    val maybe = remember(d) { weightChartData(d) }
    if (maybe == null) {
        Section("Weight and projections") { Small("No weigh-ins yet.") }
        return
    }
    val chart: WeightChartData = maybe
    Section("Weight and projections") {
        WeightChart(chart, unit, selected = null, onTap = { onExpand() })
        WeightLegend(d)
    }
}

@Composable
private fun WeightDetail(d: NutritionDashboardDto, chart: WeightChartData, unit: String, s: LocalDate) {
    val today = chart.today
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Color(0x22000000)).padding(8.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(s.format(DateTimeFormatter.ofPattern("d MMM yyyy")), style = MaterialTheme.typography.labelLarge)
            // Nearest weigh-in within 2 days of the tap.
            val near = chart.weights.minByOrNull { abs(ChronoUnit.DAYS.between(it.first, s)) }?.takeIf { abs(ChronoUnit.DAYS.between(it.first, s)) <= 2 }
            if (!s.isAfter(today)) {
                near?.let { Small("Weigh-in ${it.first.format(DateTimeFormatter.ofPattern("d MMM"))}: ${formatWeight(it.second, unit)}") } ?: Small("No weigh-in near this date")
                chart.postWeights.minByOrNull { abs(ChronoUnit.DAYS.between(it.first, s)) }?.takeIf { abs(ChronoUnit.DAYS.between(it.first, s)) <= 2 }?.let {
                    Small("Post-activity ${it.first.format(DateTimeFormatter.ofPattern("d MMM"))}: ${formatWeight(it.second, unit)}", NC.postRun)
                }
            } else {
                chart.lines.forEach { l ->
                    val p = d.projections.first { it.method == l.method }
                    Small("${p.label}: ${formatWeight(projectedKg(chart, l, s), unit)}", NC.projection(l.method))
                }
                Small("7-day avg if unchanged: ${formatWeight(chart.anchorKg, unit)}", NC.avg)
            }
        }
}

// How far a view extends beyond the visible display area (past the status bar,
// the camera cutout or the navigation buttons), in px. Android sizes the
// full-screen dialog's content to the whole display but can place its window
// inside the system bars, so the right and bottom edges got cut off. Measured
// rather than assumed because the amounts differ by phone and rotation; re-read
// a few times a second since they change when the phone rotates.
private data class Overflow(val left: Int = 0, val top: Int = 0, val right: Int = 0, val bottom: Int = 0)

@Composable
private fun rememberOverflow(view: View): Overflow {
    var overflow by remember { mutableStateOf(Overflow()) }
    LaunchedEffect(view) {
        val loc = IntArray(2)
        val vis = Rect()
        while (true) {
            view.getLocationOnScreen(loc)
            view.getWindowVisibleDisplayFrame(vis)
            val now = Overflow(
                left = max(0, vis.left - loc[0]),
                top = max(0, vis.top - loc[1]),
                right = max(0, loc[0] + view.width - vis.right),
                bottom = max(0, loc[1] + view.height - vis.bottom),
            )
            if (now != overflow) overflow = now
            delay(200)
        }
    }
    return overflow
}

// ── Full-screen charts: landscape, pinch to zoom the date axis, drag to
// scroll, tap for a day's values. Closing returns to portrait. `leftDp` and
// `rightDp` are the chart's y-label gutters, for the gesture maths. ──
@Composable
private fun FullscreenChart(
    title: String,
    leftDp: Int,
    onClose: () -> Unit,
    rightDp: Int = 0,
    refreshing: Boolean = false,
    onRefresh: () -> Unit = {},
    controls: @Composable () -> Unit = {},
    overlay: @Composable BoxScope.() -> Unit = {},
    footer: @Composable () -> Unit,
    chart: @Composable (modifier: Modifier, zoom: Float, offset: Float) -> Unit,
) {
    val activity = LocalContext.current.findActivity()
    DisposableEffect(Unit) {
        activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        onDispose { activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
    }
    var zoom by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableFloatStateOf(0f) }
    var widthPx by remember { mutableIntStateOf(0) }
    val leftPx = with(LocalDensity.current) { leftDp.dp.toPx() }
    val rightPx = with(LocalDensity.current) { rightDp.dp.toPx() }

    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        // Edge to edge (over the camera cutout), then padded by however much of the
        // content is measured to fall outside the visible area, so nothing is cut
        // off or sits under the navigation buttons.
        val dialogView = LocalView.current
        SideEffect {
            (dialogView.parent as? DialogWindowProvider)?.window?.let { w ->
                w.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
                w.attributes = w.attributes.apply {
                    layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                }
            }
        }
        val edge = rememberOverflow(dialogView)
        val density = LocalDensity.current
        Column(
            Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)
                .padding(
                    start = with(density) { edge.left.toDp() }, top = with(density) { edge.top.toDp() },
                    end = with(density) { edge.right.toDp() }, bottom = with(density) { edge.bottom.toDp() },
                )
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                // A fixed one-line header: the hint gives way (and ellipsizes) before anything
                // wraps, and nothing is added to it while zoomed, so zooming never changes its
                // height or the chart's size.
                Text(title, style = MaterialTheme.typography.titleSmall, maxLines = 1, softWrap = false)
                Text(
                    "Pinch to zoom · drag to scroll · tap for values · pull down to sync",
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary,
                    maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                )
                controls()
                TextButton(onClick = onClose) { Text("✕ Close", maxLines = 1, softWrap = false) }
            }
            Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(
                    Modifier.weight(1f).fillMaxHeight()
                        .onSizeChanged { widthPx = it.width }
                        .pointerInput(Unit) {
                            // Pinch to zoom and drag to scroll the date axis, as before; and a clear
                            // single-finger pull straight down syncs all the weight and calorie data
                            // (the same sync as pull-to-refresh on the portrait screen).
                            awaitEachGesture {
                                awaitFirstDown(requireUnconsumed = false)
                                val slop = viewConfiguration.touchSlop
                                var pastSlop = false
                                var zoomMotion = 0f
                                var panMotion = 0f
                                var pinched = false
                                var pullY = 0f
                                var driftX = 0f
                                do {
                                    val event = awaitPointerEvent()
                                    if (event.changes.any { it.isConsumed }) break
                                    if (event.changes.count { it.pressed } > 1) pinched = true
                                    val gestureZoom = event.calculateZoom()
                                    val pan = event.calculatePan()
                                    if (!pastSlop) {
                                        zoomMotion += abs(1 - gestureZoom) * event.calculateCentroidSize(useCurrent = false)
                                        panMotion += pan.getDistance()
                                        if (zoomMotion > slop || panMotion > slop) pastSlop = true
                                    }
                                    if (pastSlop && (gestureZoom != 1f || pan != androidx.compose.ui.geometry.Offset.Zero)) {
                                        val centroid = event.calculateCentroid(useCurrent = false)
                                        val plotW = (widthPx - leftPx - rightPx).coerceAtLeast(1f)
                                        val newZoom = (zoom * gestureZoom).coerceIn(1f, 12f)
                                        val anchor = centroid.x - leftPx
                                        val newOffset = (offset + anchor) * (newZoom / zoom) - anchor - pan.x
                                        zoom = newZoom
                                        offset = newOffset.coerceIn(0f, plotW * (newZoom - 1f))
                                        if (!pinched) { pullY += pan.y; driftX += abs(pan.x) }
                                        event.changes.forEach { if (it.positionChanged()) it.consume() }
                                    }
                                } while (event.changes.any { it.pressed })
                                if (!pinched && pullY > 90.dp.toPx() && driftX < pullY * 0.5f) onRefresh()
                            }
                        },
                ) {
                    chart(Modifier.fillMaxSize(), zoom, offset)
                    overlay() // floats over the chart, so showing or hiding it never resizes the chart
                    if (refreshing) {
                        Row(
                            Modifier.align(Alignment.TopCenter).padding(top = 6.dp).clip(RoundedCornerShape(20.dp))
                                .background(Color(0xF00F172A)).padding(horizontal = 12.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                            Small("Syncing weight and calories…")
                        }
                    }
                    // Only shown while zoomed in, floating at the top right so the header stays put.
                    if (zoom > 1.01f) {
                        TextButton(
                            onClick = { zoom = 1f; offset = 0f },
                            modifier = Modifier.align(Alignment.TopEnd).padding(top = 4.dp, end = 4.dp),
                        ) { Text("Reset zoom", maxLines = 1, softWrap = false) }
                    }
                }
            }
            footer()
        }
    }
}

// A tapped day's details, floating over the top-left of the chart. Tap it to dismiss.
@Composable
private fun BoxScope.FloatingDetail(onDismiss: () -> Unit, content: @Composable () -> Unit) {
    Box(
        Modifier.align(Alignment.TopStart).padding(8.dp).widthIn(max = 300.dp)
            .clip(RoundedCornerShape(10.dp)).background(Color(0xF00F172A)).clickable(onClick = onDismiss),
    ) { content() }
}

@Composable
private fun CaloriesFullscreen(d: NutritionDashboardDto, range: Int, onRange: (Int) -> Unit, refreshing: Boolean, onRefresh: () -> Unit, onClose: () -> Unit) {
    var hidden by remember { mutableStateOf(setOf<String>()) }
    var selected by remember(d) { mutableStateOf<Int?>(null) }
    FullscreenChart(
        "Daily calories", CAL_LEFT_DP, onClose, refreshing = refreshing, onRefresh = onRefresh,
        controls = { RANGES.forEach { r -> FilterChip(selected = range == r, onClick = { onRange(r) }, label = { Text("${r}d") }) } },
        overlay = {
            selected?.let { i -> d.days.getOrNull(i) }?.let { day -> FloatingDetail({ selected = null }) { DayDetail(day) } }
        },
        footer = {
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Box(Modifier.weight(1f)) { CaloriesLegend(hidden) { hidden = it } }
                Text("Tap a day for its details.", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary, maxLines = 1, softWrap = false)
            }
        },
    ) { modifier, zoom, offset ->
        CaloriesChart(d.days, d.config.dailyCalorieLimit, d.config.minDailyCalories, hidden, selected, onTap = { selected = it }, modifier = modifier, zoom = zoom, offset = offset)
    }
}

@Composable
private fun WeightFullscreen(d: NutritionDashboardDto, unit: String, refreshing: Boolean, onRefresh: () -> Unit, onClose: () -> Unit) {
    val maybe = remember(d) { weightChartData(d) }
    var selected by remember(d) { mutableStateOf<LocalDate?>(null) }
    if (maybe == null) return
    val chart: WeightChartData = maybe
    FullscreenChart(
        "Weight and projections", 0, onClose, rightDp = WEIGHT_AXIS_DP, refreshing = refreshing, onRefresh = onRefresh,
        overlay = {
            selected?.let { date -> FloatingDetail({ selected = null }) { WeightDetail(d, chart, unit, date) } }
        },
        footer = {
            // The legend takes the leftover width and wraps; the hint keeps its own one-line
            // width. (Giving the hint the leftover instead left it almost no width once the
            // legend filled the line, so it wrapped a letter per line into a column hundreds
            // of pixels tall that squeezed the chart to nothing.)
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Box(Modifier.weight(1f)) { WeightLegend(d) }
                Text("Tap a date for its values.", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary, maxLines = 1, softWrap = false)
            }
        },
    ) { modifier, zoom, offset ->
        WeightChart(chart, unit, selected, onTap = { selected = it }, modifier = modifier, zoom = zoom, offset = offset)
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
