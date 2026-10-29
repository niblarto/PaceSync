package com.pacesync.app.ui.nutrition

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pacesync.app.network.NutritionApi
import com.pacesync.app.network.dto.AcceptItemBody
import com.pacesync.app.network.dto.AcceptItemRequest
import com.pacesync.app.network.dto.LoggedItemDto
import com.pacesync.app.network.dto.SnackDto
import com.pacesync.app.network.dto.SnackItemDto
import com.pacesync.app.network.dto.SnackMeDto
import com.pacesync.app.network.dto.SnackMeRequest
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import kotlin.math.roundToInt

// "Snack Me!" on the Nutrition tab: snacks from your own Lose It! history (the Snacks entries of your last 720 days
// with food logged) that fit under what is left of the day's calorie limit, found by the server (lib/snack-builder.ts).
// Each item can be added to today's Snacks on its own, or a whole combination at once. Shuffle picks another set.
// `onClose(added)` says whether anything was added, so the screen can reload the diary and the day's totals.

private val SNACKS_MEAL = 3
private val GREEN = Color(0xFF6EE7B7)
private val RED = Color(0xFFF87171)

private sealed interface ItemState {
    object Busy : ItemState
    data class Done(val logged: LoggedItemDto) : ItemState
    data class Failed(val message: String) : ItemState
}

private fun kcalText(v: Double): String = "%,d".format(v.roundToInt())
private fun g(v: Double): String = if (v < 10) "%.1f".format(java.util.Locale.US, v) else v.roundToInt().toString()
private fun macrosText(p: Double, c: Double, f: Double) = "P ${g(p)} · C ${g(c)} · F ${g(f)}"
private fun lastDate(d: String): String = runCatching { LocalDate.parse(d).format(DateTimeFormatter.ofPattern("EEE d MMM yyyy")) }.getOrDefault(d)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SnackMeSheet(nutritionApi: NutritionApi, date: String, kcalLeft: Double, limit: Double?, onClose: (added: Boolean) -> Unit) {
    val scope = rememberCoroutineScope()
    var shuffle by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var result by remember { mutableStateOf<SnackMeDto?>(null) }
    var items by remember { mutableStateOf(mapOf<String, ItemState>()) }
    var bulk by remember { mutableStateOf(false) }

    LaunchedEffect(shuffle) {
        loading = true; error = null
        val resp = runCatching { nutritionApi.snackMe(SnackMeRequest(kcalLeft)) }.getOrNull()
        if (resp?.isSuccessful == true && resp.body() != null) { result = resp.body(); items = items.filterValues { it is ItemState.Done } }
        else error = "Couldn't find snacks (${resp?.code() ?: "offline"})"
        loading = false
    }

    val busy = bulk || items.values.any { it is ItemState.Busy }
    val added = items.values.filterIsInstance<ItemState.Done>().sumOf { it.logged.kcal }
    val anyAdded = items.values.any { it is ItemState.Done }

    suspend fun accept(key: String, it: SnackItemDto) {
        items = items + (key to ItemState.Busy)
        val resp = runCatching {
            nutritionApi.acceptItem(AcceptItemRequest(date, SNACKS_MEAL, AcceptItemBody(it.name, it.brand, it.amount, it.units, it.kcal)))
        }.getOrNull()
        items = items + (key to (
            if (resp?.isSuccessful == true && resp.body() != null) ItemState.Done(resp.body()!!.logged)
            else ItemState.Failed("Couldn't add (${resp?.code() ?: "offline"})")
        ))
    }

    ModalBottomSheet(onDismissRequest = { if (!busy) onClose(anyAdded) }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Snack Me! 🍫", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "${kcalText(kcalLeft)} kcal left${limit?.let { " of ${kcalText(it)}" } ?: ""}",
                        style = MaterialTheme.typography.bodySmall, color = GREEN,
                    )
                    if (anyAdded) Text(
                        "Added ${kcalText(added)} kcal · ${kcalText(kcalLeft - added)} kcal left",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary,
                    )
                }
                TextButton(onClick = { shuffle++ }, enabled = !loading && !busy) { Text("Shuffle") }
                TextButton(onClick = { onClose(anyAdded) }, enabled = !busy) { Text("Close") }
            }
            result?.let { r ->
                Text(
                    "${r.fitFoods} of your snacks and ${r.fitDays} past snack days fit",
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary,
                )
            }
            error?.let { Text(it, color = RED, style = MaterialTheme.typography.bodySmall) }

            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (loading) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Text("Looking through your snacks…", color = MaterialTheme.colorScheme.secondary)
                } else {
                    val r = result
                    if (r != null && r.foods.isEmpty() && r.days.isEmpty()) {
                        Text("None of your past snacks fit under ${kcalText(kcalLeft)} kcal.", color = MaterialTheme.colorScheme.secondary)
                    }
                    if (r != null && r.foods.isNotEmpty()) {
                        Text("Single snacks", style = MaterialTheme.typography.labelLarge)
                        r.foods.forEachIndexed { i, s -> SnackCard(s, "f$i", kcalLeft, items, busy, bulk, { k, it -> scope.launch { accept(k, it) } }) { k ->
                            scope.launch { bulk = true; s.items.forEachIndexed { j, it -> if (items["$k:$j"] !is ItemState.Done) accept("$k:$j", it) }; bulk = false }
                        } }
                    }
                    if (r != null && r.days.isNotEmpty()) {
                        Text("Snacks you've had together", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 4.dp))
                        r.days.forEachIndexed { i, s -> SnackCard(s, "d$i", kcalLeft, items, busy, bulk, { k, it -> scope.launch { accept(k, it) } }) { k ->
                            scope.launch { bulk = true; s.items.forEachIndexed { j, it -> if (items["$k:$j"] !is ItemState.Done) accept("$k:$j", it) }; bulk = false }
                        } }
                    }
                }
                Spacer(Modifier.height(8.dp))
            }
        }
    }
}

@Composable
private fun SnackCard(
    s: SnackDto, prefix: String, kcalLeft: Double, items: Map<String, ItemState>, busy: Boolean, bulk: Boolean,
    onAdd: (String, SnackItemDto) -> Unit, onAddAll: (String) -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Color(0x22000000)).padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row {
            Text(
                if (s.kind == "day") "Snacks on ${lastDate(s.last)}" else s.name,
                style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f).padding(end = 8.dp),
                maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
            Text("${kcalText(s.totals.kcal)} kcal", style = MaterialTheme.typography.labelLarge, color = GREEN)
        }
        Text(
            (if (s.kind == "food") "Logged ${s.times}× as a snack, last ${lastDate(s.last)}" else "${s.items.size} foods eaten together") +
                " · leaves ${kcalText(kcalLeft - s.totals.kcal)} kcal",
            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary,
        )
        s.items.forEachIndexed { j, it ->
            val st = items["$prefix:$j"]
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).padding(end = 8.dp)) {
                    Text(if (st is ItemState.Done) st.logged.name else it.name, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(
                        if (st is ItemState.Done) "${st.logged.label} · ${kcalText(st.logged.kcal)} kcal · ${macrosText(st.logged.proteinG, st.logged.carbsG, st.logged.fatG)}"
                        else "${it.label} · ${kcalText(it.kcal)} kcal · ${macrosText(it.proteinG, it.carbsG, it.fatG)}",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary,
                    )
                    if (st is ItemState.Failed) Text(st.message, style = MaterialTheme.typography.labelSmall, color = RED)
                }
                when (st) {
                    is ItemState.Done -> Text("Added ✓", style = MaterialTheme.typography.labelMedium, color = GREEN)
                    ItemState.Busy -> CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    else -> OutlinedButton(onClick = { onAdd("$prefix:$j", it) }, enabled = !busy) { Text(if (st is ItemState.Failed) "Retry" else "Add") }
                }
            }
        }
        if (s.items.size > 1) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                Button(onClick = { onAddAll(prefix) }, enabled = !busy && s.items.indices.any { items["$prefix:$it"] !is ItemState.Done }) {
                    Text(if (bulk) "Adding…" else "Add all")
                }
            }
        }
    }
}
