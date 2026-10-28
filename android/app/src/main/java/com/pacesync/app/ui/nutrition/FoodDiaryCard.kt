package com.pacesync.app.ui.nutrition

import android.app.DatePickerDialog
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pacesync.app.network.NutritionApi
import com.pacesync.app.network.dto.LoseItDiaryDto
import com.pacesync.app.network.dto.LoseItFoodDto
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.roundToInt

// The Lose It! food diary for one day, by meal — read by the server from
// Lose It! (lib/loseit-food.ts). Opening today or yesterday asks the server to
// re-read it first (throttled there to once per 5 minutes, a few KB each);
// older days come from the stored history. `reloadKey` changes after the
// screen's pull-to-refresh so the diary reloads with everything else.

private val UNIT_ABBR = mapOf("Gram" to "g", "Milliliter" to "ml", "Milligram" to "mg", "Liter" to "l", "Ounce" to "oz")

// "7 g", "1 Serving", "2 Servings", "6 Pieces".
private fun amount(f: LoseItFoodDto): String {
    val q = f.quantity ?: return ""
    val n = if (q == Math.floor(q)) q.toLong().toString() else "%.2f".format(java.util.Locale.US, q).trimEnd('0').trimEnd('.')
    val u = f.units ?: return n
    UNIT_ABBR[u]?.let { return "$n $it" }
    val plural = if (q == 1.0 || u == "Each") u else if (Regex("(s|sh|ch|x)$", RegexOption.IGNORE_CASE).containsMatchIn(u)) "${u}es" else "${u}s"
    return "$n $plural"
}

private fun kcalText(v: Double?): String = if (v == null) "—" else "%,d".format(v.roundToInt())
private fun grams(v: Double?): String = when {
    v == null -> "—"
    v < 10 -> "%.1f".format(java.util.Locale.US, v)
    else -> v.roundToInt().toString()
}
private fun macros(p: Double?, c: Double?, f: Double?) = "P ${grams(p)} · C ${grams(c)} · F ${grams(f)}"

@Composable
fun FoodDiaryCard(nutritionApi: NutritionApi, reloadKey: Int) {
    val context = LocalContext.current
    val today = remember { LocalDate.now() }
    var date by remember { mutableStateOf(LocalDate.now()) }
    var diary by remember { mutableStateOf<LoseItDiaryDto?>(null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // Meal names folded to just their calories; kept in preferences so it
    // survives switching tabs (which leaves this screen) and restarting the app.
    val prefs = remember { context.getSharedPreferences("food_diary", Context.MODE_PRIVATE) }
    var collapsed by remember { mutableStateOf(prefs.getStringSet("collapsed", emptySet())?.toSet() ?: emptySet()) }
    fun setCollapsed(next: Set<String>) {
        collapsed = next
        prefs.edit().putStringSet("collapsed", next).apply()
    }

    LaunchedEffect(date, reloadKey) {
        loading = true
        val recent = !date.isBefore(LocalDate.now().minusDays(1))
        val resp = runCatching { nutritionApi.getDiary(date.toString(), if (recent) 1 else 0) }.getOrNull()
        if (resp?.isSuccessful == true && resp.body() != null) { diary = resp.body(); error = null }
        else error = "Couldn't load the food diary (${resp?.code() ?: "offline"})"
        loading = false
    }

    val title = when (date) {
        today -> "Today"
        today.minusDays(1) -> "Yesterday"
        else -> date.format(DateTimeFormatter.ofPattern("EEE d MMM yyyy"))
    }

    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.88f))) {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Food diary · $title", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (loading) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = { date = date.minusDays(1) }) { Text("‹ Prev") }
                TextButton(onClick = {
                    DatePickerDialog(context, { _, y, m, d -> date = LocalDate.of(y, m + 1, d) }, date.year, date.monthValue - 1, date.dayOfMonth).apply {
                        datePicker.maxDate = System.currentTimeMillis()
                    }.show()
                }) { Text("Pick date") }
                TextButton(onClick = { date = date.plusDays(1) }, enabled = date.isBefore(today)) { Text("Next ›") }
                if (date != today) TextButton(onClick = { date = today }) { Text("Today") }
            }

            error?.let { Text(it, color = Color(0xFFF87171), style = MaterialTheme.typography.bodySmall) }
            val d = diary
            when {
                d == null -> {}
                !d.connected && d.meals.isEmpty() -> Text(
                    "Connect your Lose It! account in Settings → Lose It! food diary to see the foods you log each day.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary,
                )
                d.meals.isEmpty() -> if (!loading) Text(
                    if (date == today) "Nothing logged yet." else "Nothing logged.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary,
                )
                else -> {
                    d.meals.forEach { m ->
                        val open = m.name !in collapsed
                        Column(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Color(0x22000000)).padding(10.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            // Tapping the meal's title folds it down to just its calories.
                            Row(
                                Modifier.fillMaxWidth().clickable { setCollapsed(if (open) collapsed + m.name else collapsed - m.name) },
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(if (open) "▾" else "▸", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.secondary)
                                Text(m.name, style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f).padding(start = 6.dp))
                                Text("${kcalText(m.totals.kcal)} kcal", style = MaterialTheme.typography.labelLarge)
                            }
                            if (open) {
                                m.foods.forEach { f -> FoodRow(f) }
                                Text(
                                    macros(m.totals.proteinG, m.totals.carbsG, m.totals.fatG),
                                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary,
                                    modifier = Modifier.align(Alignment.End),
                                )
                            }
                        }
                    }
                    Text(
                        "Total ${kcalText(d.totals.kcal)} kcal · protein ${grams(d.totals.proteinG)} g · carbs ${grams(d.totals.carbsG)} g · fat ${grams(d.totals.fatG)} g",
                        style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium,
                    )
                }
            }
            d?.lastSyncAt?.let { at ->
                val t = runCatching { OffsetDateTime.parse(at).atZoneSameInstant(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("HH:mm")) }.getOrNull()
                if (t != null && d.connected) Text("Synced from Lose It! $t", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary)
            }
            d?.lastError?.let { Text("Last sync failed: $it", style = MaterialTheme.typography.labelSmall, color = Color(0xFFF87171)) }
        }
    }
}

@Composable
private fun FoodRow(f: LoseItFoodDto) {
    Row(verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f).padding(end = 8.dp)) {
            Text(f.name, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            val sub = listOfNotNull(f.brand, amount(f).ifBlank { null }).joinToString(" · ")
            if (sub.isNotEmpty()) Text(sub, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(kcalText(f.kcal), style = MaterialTheme.typography.bodySmall)
            Text(macros(f.proteinG, f.carbsG, f.fatG), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary)
        }
    }
}
