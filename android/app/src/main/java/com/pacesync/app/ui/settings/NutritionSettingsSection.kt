package com.pacesync.app.ui.settings

import android.app.DatePickerDialog
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.pacesync.app.network.NutritionApi
import com.pacesync.app.network.dto.NutritionSettingsDto
import com.pacesync.app.network.dto.NutritionSettingsRequest
import com.pacesync.app.ui.nutrition.LB_PER_KG
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.ceil
import kotlin.math.floor

// The same Nutrition goals as Settings → Nutrition goals on the web: weight units,
// target weight, goal date, daily calorie limit and the projection settings. They
// are stored on the server (api/settings/nutrition), so a change here shows on the
// web and vice versa.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NutritionSettingsSection(nutritionApi: NutritionApi) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var loaded by remember { mutableStateOf<NutritionSettingsDto?>(null) }
    var failed by remember { mutableStateOf(false) }
    var unit by remember { mutableStateOf("st") }
    var st by remember { mutableStateOf("") }
    var lb by remember { mutableStateOf("") }
    var single by remember { mutableStateOf("") } // kg or lb, depending on unit
    var goalDate by remember { mutableStateOf("") }
    var limit by remember { mutableStateOf("") }
    var trendDays by remember { mutableStateOf("28") }
    var kcalPerKg by remember { mutableStateOf("7700") }
    var showProjection by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }

    fun fill(c: NutritionSettingsDto) {
        loaded = c
        unit = c.weightUnit
        val kg = c.targetWeightKg
        if (kg == null) { st = ""; lb = ""; single = "" } else {
            val (s, l) = kgToStLb(kg)
            st = s.toString(); lb = fmt1(l)
            single = if (c.weightUnit == "lb") fmt1(kg * LB_PER_KG) else fmt1(kg)
        }
        goalDate = c.goalDate ?: ""
        limit = c.dailyCalorieLimit?.let { it.toLong().toString() } ?: ""
        trendDays = c.trendDays.toString()
        kcalPerKg = c.kcalPerKg.toLong().toString()
    }

    LaunchedEffect(Unit) {
        val resp = runCatching { nutritionApi.getSettings() }.getOrNull()
        val body = resp?.takeIf { it.isSuccessful }?.body()
        if (body != null) fill(body) else failed = true
    }

    // The target weight typed in, in kg (null = blank or not a number).
    fun targetKg(): Double? {
        if (unit == "st") {
            if (st.isBlank() && lb.isBlank()) return null
            val s = st.toDoubleOrNull() ?: if (st.isBlank()) 0.0 else return null
            val l = lb.toDoubleOrNull() ?: if (lb.isBlank()) 0.0 else return null
            return (s * 14 + l) / LB_PER_KG
        }
        if (single.isBlank()) return null
        val v = single.toDoubleOrNull() ?: return null
        return if (unit == "lb") v / LB_PER_KG else v
    }

    // Switching unit converts the typed target rather than reinterpreting it.
    fun changeUnit(next: String) {
        val kg = targetKg()
        unit = next
        if (kg == null) { st = ""; lb = ""; single = "" } else {
            val (s, l) = kgToStLb(kg)
            st = s.toString(); lb = fmt1(l)
            single = if (next == "lb") fmt1(kg * LB_PER_KG) else fmt1(kg)
        }
        status = null
    }

    Text("Nutrition goals", style = MaterialTheme.typography.titleMedium)
    Text(
        "Food comes from Lose It! (synced by the server, below). Calories burnt and weigh-ins come from Garmin. " +
            "These are the same goals as Settings → Nutrition goals on the web.",
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary,
    )

    val cfg = loaded
    if (cfg == null) {
        Text(if (failed) "Couldn't load the nutrition goals — is the token set and the server reachable?" else "Loading…", style = MaterialTheme.typography.bodySmall)
        return
    }

    val target = targetKg()
    val earliest = remember(cfg.currentKg, target, cfg.today, cfg.maxLossLbPerWeek) {
        val cur = cfg.currentKg
        val today = cfg.today?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
        if (cur == null || target == null || today == null) null
        else if (cur <= target) today
        else today.plusDays(ceil((cur - target) / (cfg.maxLossLbPerWeek / LB_PER_KG / 7)).toLong())
    }
    val goal = goalDate.takeIf { it.isNotBlank() }?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
    val tooSoon = goal != null && earliest != null && goal.isBefore(earliest)
    val pretty = DateTimeFormatter.ofPattern("d MMM yyyy")

    Text("Weight units", style = MaterialTheme.typography.labelMedium)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf("st" to "Stones & lb", "lb" to "Pounds", "kg" to "Kilograms").forEach { (u, label) ->
            FilterChip(selected = unit == u, onClick = { changeUnit(u) }, label = { Text(label) })
        }
    }

    Text("Target weight", style = MaterialTheme.typography.labelMedium)
    val numberKeys = KeyboardOptions(keyboardType = KeyboardType.Decimal)
    if (unit == "st") {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(st, { st = it; status = null }, label = { Text("st") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(1f))
            OutlinedTextField(lb, { lb = it; status = null }, label = { Text("lb") }, singleLine = true,
                keyboardOptions = numberKeys, modifier = Modifier.weight(1f))
        }
    } else {
        OutlinedTextField(single, { single = it; status = null }, label = { Text(unit) }, singleLine = true,
            keyboardOptions = numberKeys, modifier = Modifier.fillMaxWidth())
    }

    OutlinedTextField(
        value = goalDate, onValueChange = { goalDate = it; status = null },
        label = { Text("Goal date (YYYY-MM-DD)") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
        isError = tooSoon || (goalDate.isNotBlank() && goal == null),
        trailingIcon = {
            TextButton(onClick = {
                val start = goal ?: earliest ?: LocalDate.now()
                DatePickerDialog(context, { _, y, m, d -> goalDate = LocalDate.of(y, m + 1, d).toString(); status = null },
                    start.year, start.monthValue - 1, start.dayOfMonth).apply {
                    earliest?.let { datePicker.minDate = it.atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli() }
                }.show()
            }) { Text("Pick") }
        },
    )
    if (tooSoon) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Needs more than ${fmt1(cfg.maxLossLbPerWeek)} lb a week. Earliest: ${earliest!!.format(pretty)}.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.weight(1f),
            )
            TextButton(onClick = { goalDate = earliest.toString(); status = null }) { Text("Use it") }
        }
    } else {
        Text(
            "Max ${fmt1(cfg.maxLossLbPerWeek)} lb a week${earliest?.let { "; earliest ${it.format(pretty)}" } ?: ""}.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary,
        )
    }

    OutlinedTextField(
        limit, { limit = it.filter(Char::isDigit); status = null },
        label = { Text("Daily calorie limit (kcal eaten)") }, placeholder = { Text("e.g. 2000") }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth(),
    )

    TextButton(onClick = { showProjection = !showProjection }) {
        Text(if (showProjection) "▾ Projection settings" else "▸ Projection settings")
    }
    if (showProjection) {
        OutlinedTextField(
            trendDays, { trendDays = it.filter(Char::isDigit); status = null },
            label = { Text("Base projections on the last N days") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            kcalPerKg, { kcalPerKg = it.filter(Char::isDigit); status = null },
            label = { Text("kcal per kg of weight change") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth(),
        )
        Text(
            "7,700 kcal per kg (about 3,500 per lb) is the usual estimate.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary,
        )
    }

    Button(
        onClick = {
            val kg = targetKg()
            if (target == null && (st.isNotBlank() || lb.isNotBlank() || single.isNotBlank())) { status = "Target weight isn't a number"; return@Button }
            if (goalDate.isNotBlank() && goal == null) { status = "Goal date should look like 2027-01-11"; return@Button }
            saving = true; status = null
            val body = NutritionSettingsRequest(
                targetWeightKg = kg,
                goalDate = goalDate.ifBlank { null },
                dailyCalorieLimit = limit.toDoubleOrNull(),
                minDailyCalories = cfg.minDailyCalories, // not editable here or on the web; kept as is
                weightUnit = unit,
                trendDays = trendDays.toIntOrNull() ?: 28,
                kcalPerKg = kcalPerKg.toDoubleOrNull() ?: 7700.0,
            )
            scope.launch {
                val resp = runCatching { nutritionApi.saveSettings(body) }.getOrNull()
                if (resp == null) status = "Couldn't reach the server"
                else if (resp.isSuccessful && resp.body() != null) { fill(resp.body()!!); status = "Saved." }
                else status = resp.errorBody()?.string()?.let {
                    runCatching { Json.parseToJsonElement(it).jsonObject["error"]?.jsonPrimitive?.content }.getOrNull()
                } ?: "Save failed (${resp.code()})"
                saving = false
            }
        },
        enabled = !saving && !tooSoon,
        modifier = Modifier.fillMaxWidth(),
    ) { Text(if (saving) "Saving…" else "Save nutrition goals") }
    status?.let {
        Text(it, style = MaterialTheme.typography.bodySmall,
            color = if (it == "Saved.") MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.error,
            modifier = Modifier.padding(top = 2.dp))
    }
}

// Same rounding as lib/weight-format.ts's kgToStLb: stones and pounds to one decimal.
private fun kgToStLb(kg: Double): Pair<Int, Double> {
    val totalLb = kg * LB_PER_KG
    var st = floor(totalLb / 14).toInt()
    var lb = Math.round((totalLb - st * 14) * 10) / 10.0
    if (lb >= 14) { st += 1; lb -= 14 }
    return st to lb
}

private fun fmt1(v: Double): String = "%.1f".format(java.util.Locale.US, v)
