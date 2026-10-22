package com.pacesync.app.ui.coach

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pacesync.app.network.CoachApi
import com.pacesync.app.network.dto.RunFeedbackRequest
import kotlinx.coroutines.launch

val FEEL_EMOJI = listOf("😫", "😕", "😐", "🙂", "😄")
val FEEL_LABEL = listOf("Very weak", "Weak", "Normal", "Strong", "Very strong")

fun effortLabel(n: Int): String = when {
    n <= 2 -> "Very easy"; n <= 4 -> "Easy"; n <= 6 -> "Moderate"; n <= 8 -> "Hard"; n == 9 -> "Very hard"; else -> "Maximal"
}

private fun effortColor(n: Int): Color = when {
    n <= 3 -> Color(0xFF10B981); n <= 6 -> Color(0xFFF59E0B); n <= 8 -> Color(0xFFF97316); else -> Color(0xFFEF4444)
}

// "How did it feel?" for a finished run — same store as the web Summary
// card's panel (app/api/run-feedback); the Coach reads it. Folds to its
// title once effort and feel are both set; tap the title to open/close.
@Composable
fun RunFeedbackCard(coachApi: CoachApi, date: String, title: String) {
    val scope = rememberCoroutineScope()
    var loaded by remember { mutableStateOf(false) }
    var effort by remember { mutableStateOf<Int?>(null) }
    var feel by remember { mutableStateOf<Int?>(null) }
    var notes by remember { mutableStateOf("") }
    var savedNotes by remember { mutableStateOf("") }
    var open by remember { mutableStateOf(true) }
    var status by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(date, title) {
        val fb = runCatching { coachApi.getRunFeedback(date, title).body()?.feedback }.getOrNull()
        effort = fb?.effort
        feel = fb?.feel
        notes = fb?.notes ?: ""
        savedNotes = notes
        open = !(effort != null && feel != null)
        loaded = true
    }

    fun save() {
        status = "Saving…"
        scope.launch {
            val ok = runCatching {
                coachApi.saveRunFeedback(RunFeedbackRequest(date, title, effort, feel, notes.trim().ifEmpty { null })).isSuccessful
            }.getOrDefault(false)
            if (ok) savedNotes = notes.trim()
            status = if (ok) "Saved ✓" else "Couldn't save"
        }
    }

    fun pick(e: Int?, f: Int?) {
        val wasComplete = effort != null && feel != null
        effort = e
        feel = f
        if (e != null && f != null && !wasComplete) open = false
        save()
    }

    if (!loaded) return
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                Modifier.fillMaxWidth().clickable { open = !open },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(if (open) "▼" else "▶", fontSize = 10.sp, color = MaterialTheme.colorScheme.secondary)
                Text("How did it feel?", style = MaterialTheme.typography.labelLarge)
                if (!open && (effort != null || feel != null)) {
                    Text(
                        listOfNotNull(
                            effort?.let { "Effort $it/10" },
                            feel?.let { "${FEEL_EMOJI[it - 1]} ${FEEL_LABEL[it - 1]}" },
                            if (savedNotes.isNotEmpty()) "📝" else null,
                        ).joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.secondary,
                        modifier = Modifier.weight(1f),
                    )
                } else {
                    Box(Modifier.weight(1f))
                }
                status?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary) }
            }
            if (open) {
                Text(
                    "Effort" + (effort?.let { " · $it/10 ${effortLabel(it)}" } ?: " (1 = very easy, 10 = all out)"),
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(3.dp), modifier = Modifier.fillMaxWidth()) {
                    for (n in 1..10) {
                        val selected = effort == n
                        Box(
                            Modifier.weight(1f).height(34.dp).clip(RoundedCornerShape(6.dp))
                                .background(if (selected) effortColor(n).copy(alpha = 0.35f) else Color(0x22FFFFFF))
                                .border(BorderStroke(1.dp, if (selected) effortColor(n) else Color(0x22FFFFFF)), RoundedCornerShape(6.dp))
                                .clickable { pick(if (selected) null else n, feel) },
                            contentAlignment = Alignment.Center,
                        ) {
                            Text("$n", fontSize = 13.sp, fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal)
                        }
                    }
                }
                Text(
                    "Feel" + (feel?.let { " · ${FEEL_LABEL[it - 1]}" } ?: ""),
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.fillMaxWidth()) {
                    for (v in 1..5) {
                        val selected = feel == v
                        Box(
                            Modifier.weight(1f).height(40.dp).clip(RoundedCornerShape(6.dp))
                                .background(if (selected) Color(0x5538BDF8) else Color(0x22FFFFFF))
                                .border(BorderStroke(1.dp, if (selected) Color(0xFF38BDF8) else Color(0x22FFFFFF)), RoundedCornerShape(6.dp))
                                .clickable { pick(effort, if (selected) null else v) },
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(FEEL_EMOJI[v - 1], fontSize = 20.sp)
                        }
                    }
                }
                OutlinedTextField(
                    value = notes,
                    onValueChange = { notes = it },
                    placeholder = { Text("Notes — niggles, sleep, fuelling…") },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 2,
                    textStyle = MaterialTheme.typography.bodySmall,
                )
                if (notes.trim() != savedNotes) {
                    OutlinedButton(onClick = { save() }) { Text("Save notes") }
                }
            }
        }
    }
}
